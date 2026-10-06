import {
  API_ERRORS,
  MAX_REQUEST_BYTES,
  PATTERNS,
  ROUTES,
  TICKET_ROUTE_PATTERN,
  parseCreateTicketRequest,
  parseTicketProof,
  type ApiError,
  type ApiErrorCode,
  type CreateTicketResponse,
  type SealedTicket,
  type TicketStatus,
} from "../shared/protocol";
import { SecretBox } from "./secret-box";

export { SecretBox };

type JsonBody = ApiError | CreateTicketResponse | SealedTicket | TicketStatus;
type BodyResult = { ok: true; value: unknown } | { ok: false; error: ApiErrorCode };
type Route = {
  limiter: "CREATE_LIMITER" | "READ_LIMITER";
  handle: (body: unknown, env: Env, id: string) => Promise<Response>;
};

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const ROUTE_TABLE: Record<"create" | "status" | "claim", Route> = {
  create: { limiter: "CREATE_LIMITER", handle: createTicket },
  status: {
    limiter: "READ_LIMITER",
    handle: (body, env, id) => readTicket(body, env, id, "status"),
  },
  claim: {
    limiter: "READ_LIMITER",
    handle: (body, env, id) => readTicket(body, env, id, "claim"),
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("ticket_api_error", error instanceof Error ? error.name : "Error");
      return apiError("internal");
    }
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const site = request.headers.get("Sec-Fetch-Site");
  const origin = request.headers.get("Origin");
  if (
    (site !== null && site !== "same-origin" && site !== "none") ||
    (origin !== null && origin !== url.origin)
  ) {
    return apiError("forbidden");
  }

  const match = url.pathname.match(TICKET_ROUTE_PATTERN);
  const action = url.pathname === ROUTES.create ? "create" : match?.[2];
  if (action !== "create" && action !== "status" && action !== "claim") {
    return apiError("not_found");
  }
  if (request.method !== "POST") return apiError("method_not_allowed", { Allow: "POST" });

  const route = ROUTE_TABLE[action];
  const key = rateLimitKey(request.headers.get("CF-Connecting-IP"));
  if (!(await env[route.limiter].limit({ key })).success) return apiError("rate_limited");
  const body = await readJsonBody(request);
  if (!body.ok) return apiError(body.error);
  return route.handle(body.value, env, match?.[1] ?? "");
}

async function createTicket(body: unknown, env: Env): Promise<Response> {
  const ticket = parseCreateTicketRequest(body);
  if (!ticket) return apiError("invalid_request");
  const { id, ...record } = ticket;
  const result = await getSecretBox(env, id).store(record);
  return result === "exists" ? apiError("exists") : json(result, 201);
}

async function readTicket(
  body: unknown,
  env: Env,
  id: string,
  action: "status" | "claim",
): Promise<Response> {
  const proof = parseTicketProof(body);
  if (!proof || !PATTERNS.id.test(id)) return apiError("invalid_request");
  const result = await getSecretBox(env, id)[action](proof.claimSecret);
  return result ? json(result, 200) : apiError("not_found");
}

async function readJsonBody(request: Request): Promise<BodyResult> {
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";", 1)[0] ?? "";
  if (mediaType.trim().toLowerCase() !== "application/json") {
    return { ok: false, error: "invalid_request" };
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return { ok: false, error: "invalid_request" };
    const bytes = Number(contentLength);
    if (bytes > MAX_REQUEST_BYTES) return { ok: false, error: "too_large" };
    if (!Number.isSafeInteger(bytes) || bytes < 0) return { ok: false, error: "invalid_request" };
  }
  const bytes = await readCapped(request, MAX_REQUEST_BYTES);
  if (!bytes) return { ok: false, error: "too_large" };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, error: "invalid_request" };
  }
}

/** Keep one capped buffer plus the single chunk currently being inspected. */
async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const bytes = new Uint8Array(limit);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > limit) {
        await reader.cancel();
        return null;
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
    return bytes.subarray(0, total);
  } finally {
    reader.releaseLock();
  }
}

function rateLimitKey(ip: string | null): string {
  if (ip === null) return "unknown";
  if (!ip.includes(":")) return ip;
  // IPv4-mapped IPv6 still needs eight hextets before selecting its /64.
  const normalized = ip.toLowerCase().replace(/\d+\.\d+\.\d+\.\d+$/, (ipv4) => {
    const octets = ipv4.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) return "invalid";
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    return `${high}:${low}`;
  });
  const halves = normalized.split("::");
  if (halves.length > 2) return "unknown";
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return "unknown";
  const hextets = halves.length === 2
    ? [...left, ...Array<string>(missing).fill("0"), ...right]
    : left;
  if (hextets.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return "unknown";
  const values = hextets.map((part) => Number.parseInt(part, 16));
  // IPv4-mapped (::ffff:a.b.c.d) is one IPv4 client; bucket it as that address, not as a /64
  // that every IPv4 client would share.
  if (values.slice(0, 5).every((v) => v === 0) && values[5] === 0xffff) {
    const [high, low] = [values[6]!, values[7]!];
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return `${values.slice(0, 4).map((v) => v.toString(16)).join(":")}::/64`;
}

function getSecretBox(env: Env, id: string): DurableObjectStub<SecretBox> {
  return env.SECRET_BOX.get(env.SECRET_BOX.idFromName(id));
}

function apiError(error: ApiErrorCode, headers?: Record<string, string>): Response {
  return json({ error }, API_ERRORS[error], headers);
}

function json(body: JsonBody, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}
