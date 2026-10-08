import { createExecutionContext, env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROUTES, TTL_SECONDS, type CreateTicketRequest } from "../../src/shared/protocol";
import handler from "../../src/worker/index";

const BASE_URL = "https://stubs.test";
const VALID_IV = "AbCdEfGhIjKlMnOp";
const VALID_CIPHERTEXT = "AbCdEfGhIjKlMnOpQrStUvWx";
const SECRET_BYTES = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const CLAIM_SECRET = base64Url(SECRET_BYTES);

let points: AnalyticsEngineDataPoint[];
let testNumber = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

/** Sends one request with a recording USAGE binding, plus any other env overrides. */
async function send(route: string, body: unknown, headers: Record<string, string> = {}, overrides: Partial<Env> = {}) {
  points = [];
  const usage: AnalyticsEngineDataset = { writeDataPoint: (point) => void points.push(point!) };
  return handler.fetch(
    new Request(`${BASE_URL}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": `203.0.113.${++testNumber}`, ...headers },
      body: body instanceof ReadableStream ? body : JSON.stringify(body),
    }),
    { ...env, USAGE: usage, ...overrides },
    createExecutionContext(),
  );
}

describe("usage counts", () => {
  it.each([
    [{}, "web"],
    [{ "X-Stubs-Client": "cli" }, "cli"],
    [{ "X-Stubs-Client": "mcp" }, "mcp"],
    [{ "X-Stubs-Client": "CLI" }, "web"],
    [{ "X-Stubs-Client": "cli, mcp" }, "web"],
    [{ "X-Stubs-Client": "web" }, "web"],
  ])("counts a create with headers %j as %s and nothing else", async (headers, source) => {
    const response = await send(ROUTES.create, await createBody(), headers);
    expect(response.status).toBe(201);
    expect(points).toEqual([{ blobs: ["ticket_created", source], doubles: [TTL_SECONDS[1]] }]);
  });

  it("counts a claim, then a second claim as unavailable, and never a status check", async () => {
    const body = await createBody();
    await send(ROUTES.create, body, { "X-Stubs-Client": "cli" });

    await send(ROUTES.status(body.id), { claimSecret: CLAIM_SECRET }, { "X-Stubs-Client": "cli" });
    expect(points).toEqual([]);

    expect((await send(ROUTES.claim(body.id), { claimSecret: CLAIM_SECRET }, { "X-Stubs-Client": "cli" })).status)
      .toBe(200);
    expect(points).toEqual([{ blobs: ["ticket_claimed", "cli"] }]);

    const again = await send(ROUTES.claim(body.id), { claimSecret: CLAIM_SECRET }, { "X-Stubs-Client": "cli" });
    expect(points).toEqual([{ blobs: ["ticket_claim_unavailable", "cli"] }]);
    // The API answer is the same plain 404 as a ticket that never existed.
    const missing = await send(ROUTES.claim("Z".repeat(22)), { claimSecret: CLAIM_SECRET }, { "X-Stubs-Client": "cli" });
    expect(again.status).toBe(404);
    expect([...again.headers]).toEqual([...missing.headers]);
    await expect(again.json()).resolves.toEqual({ error: "not_found" });
  });

  it.each<Record<string, string>>([{ "Sec-GPC": "1" }, { DNT: "1" }])("writes nothing for creates or claims with %j", async (optOut) => {
    const body = await createBody();
    expect((await send(ROUTES.create, body, optOut)).status).toBe(201);
    expect(points).toEqual([]);
    expect((await send(ROUTES.claim(body.id), { claimSecret: CLAIM_SECRET }, optOut)).status).toBe(200);
    expect(points).toEqual([]);
    expect((await send(ROUTES.claim(body.id), { claimSecret: CLAIM_SECRET }, optOut)).status).toBe(404);
    expect(points).toEqual([]);
  });

  it("counts a Worker error by route and error name only", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("sensitive request body must never be counted"));
      },
    }, { highWaterMark: 0 });
    // Operational: counted even with an opt-out header, since it carries nothing about the client.
    const response = await send(ROUTES.create, failing, { "X-Stubs-Client": "cli", "Sec-GPC": "1" });
    expect(response.status).toBe(500);
    expect(points).toEqual([{ blobs: ["worker_error", "create", "TypeError"] }]);
  });

  it("counts a rate-limited request by route only", async () => {
    const limited = { limit: async () => ({ success: false }) };
    const response = await send(ROUTES.claim("Z".repeat(22)), { claimSecret: CLAIM_SECRET }, {
      "X-Stubs-Client": "mcp",
    }, { READ_LIMITER: limited });
    expect(response.status).toBe(429);
    expect(points).toEqual([{ blobs: ["rate_limited", "claim"] }]);
  });

  it("answers normally when counting throws or the binding is missing", async () => {
    const throwing: AnalyticsEngineDataset = {
      writeDataPoint: () => {
        throw new Error("dataset down");
      },
    };
    expect((await send(ROUTES.create, await createBody(), {}, { USAGE: throwing })).status).toBe(201);
    const missing = { USAGE: undefined } as unknown as Partial<Env>;
    expect((await send(ROUTES.create, await createBody(), {}, missing)).status).toBe(201);
  });
});

/** A valid create body with a fresh id, so tests never collide on "exists". */
async function createBody(): Promise<CreateTicketRequest> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", SECRET_BYTES));
  const id = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  return { id, claimHash: base64Url(digest), ciphertext: VALID_CIPHERTEXT, iv: VALID_IV, ttlSeconds: TTL_SECONDS[1] };
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
