import {
  BASE64URL_PATTERN,
  IV_PATTERN,
  MAX_CIPHERTEXT_CHARS,
  MAX_REQUEST_BYTES,
  SECRET_ID_PATTERN,
  TTL_OPTIONS,
  type ApiErrorResponse,
  type ClaimSecretResponse,
  type CreateSecretRequest,
  type CreateSecretResponse,
  type SecretStatusResponse,
} from "../shared/protocol";
import { SecretBox, type SecretRecord } from "./secret-box";

export { SecretBox };

type JsonBody =
  | ApiErrorResponse
  | ClaimSecretResponse
  | CreateSecretResponse
  | SecretStatusResponse;

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const TTL_SECONDS = new Set<number>(TTL_OPTIONS.map((option) => option.seconds));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch {
      return json({ error: "internal_error" }, 500);
    }
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/secrets") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }

    return createSecret(request, env);
  }

  const statusMatch = url.pathname.match(/^\/api\/secrets\/([^/]+)$/);

  if (statusMatch) {
    const id = statusMatch[1];

    if (typeof id !== "string") {
      return json({ error: "not_found" }, 404);
    }

    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }

    return getSecretStatus(id, request, env);
  }

  const claimMatch = url.pathname.match(/^\/api\/secrets\/([^/]+)\/claim$/);

  if (claimMatch) {
    const id = claimMatch[1];

    if (typeof id !== "string") {
      return json({ error: "not_found" }, 404);
    }

    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }

    return claimSecret(id, request, env);
  }

  return json({ error: "not_found" }, 404);
}

async function createSecret(request: Request, env: Env): Promise<Response> {
  if (!(await withinLimit(env.CREATE_LIMITER, request))) {
    return json({ error: "rate_limited" }, 429);
  }

  const body = await readJsonBody(request);

  if (body instanceof Response) {
    return body;
  }

  if (!isCreateSecretRequest(body)) {
    return json({ error: "invalid_request" }, 400);
  }

  const expiresAt = Date.now() + body.ttlSeconds * 1000;
  const record: SecretRecord = {
    ciphertext: body.ciphertext,
    iv: body.iv,
    expiresAt,
  };
  const box = getSecretBox(env, body.id);
  const result = await box.create(record);

  if (result === "exists") {
    return json({ error: "already_exists" }, 409);
  }

  return json({ expiresAt }, 201);
}

async function getSecretStatus(id: string, request: Request, env: Env): Promise<Response> {
  if (!(await withinLimit(env.READ_LIMITER, request))) {
    return json({ error: "rate_limited" }, 429);
  }

  if (!SECRET_ID_PATTERN.test(id)) {
    return json({ error: "not_found" }, 404);
  }

  const status = await getSecretBox(env, id).status();

  if (!status) {
    return json({ error: "not_found" }, 404);
  }

  return json(status, 200);
}

async function claimSecret(id: string, request: Request, env: Env): Promise<Response> {
  if (!(await withinLimit(env.READ_LIMITER, request))) {
    return json({ error: "rate_limited" }, 429);
  }

  if (!SECRET_ID_PATTERN.test(id)) {
    return json({ error: "not_found" }, 404);
  }

  const secret = await getSecretBox(env, id).claim();

  if (!secret) {
    return json({ error: "not_found" }, 404);
  }

  return json(secret, 200);
}

async function readJsonBody(request: Request): Promise<unknown | Response> {
  const contentType = request.headers.get("Content-Type") ?? "";

  const mediaType = contentType.split(";", 1)[0] ?? "";

  if (mediaType.trim().toLowerCase() !== "application/json") {
    return json({ error: "invalid_request" }, 400);
  }

  const contentLength = request.headers.get("Content-Length");

  if (contentLength !== null) {
    const bytes = Number(contentLength);

    if (!Number.isFinite(bytes) || bytes > MAX_REQUEST_BYTES) {
      return json({ error: "request_too_large" }, 413);
    }
  }

  const bytes = await readCapped(request, MAX_REQUEST_BYTES);

  if (!bytes) {
    return json({ error: "request_too_large" }, 413);
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
}

/** Reads the body but stops as soon as it passes `limit`, so chunked uploads can't balloon memory. */
async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function withinLimit(limiter: RateLimit, request: Request): Promise<boolean> {
  const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return (await limiter.limit({ key })).success;
}

function isCreateSecretRequest(value: unknown): value is CreateSecretRequest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const request = value as Record<string, unknown>;

  return (
    typeof request.id === "string" &&
    SECRET_ID_PATTERN.test(request.id) &&
    typeof request.iv === "string" &&
    IV_PATTERN.test(request.iv) &&
    typeof request.ciphertext === "string" &&
    BASE64URL_PATTERN.test(request.ciphertext) &&
    request.ciphertext.length > 22 &&
    request.ciphertext.length <= MAX_CIPHERTEXT_CHARS &&
    typeof request.ttlSeconds === "number" &&
    TTL_SECONDS.has(request.ttlSeconds)
  );
}

function getSecretBox(env: Env, id: string): DurableObjectStub<SecretBox> {
  return env.SECRET_BOX.get(env.SECRET_BOX.idFromName(id));
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "method_not_allowed" }, 405, { Allow: allow });
}

function json(body: JsonBody, status: number, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}
