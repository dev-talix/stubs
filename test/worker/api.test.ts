import { env, reset, runDurableObjectAlarm } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_ERRORS,
  MAX_CIPHERTEXT_CHARS,
  MAX_REQUEST_BYTES,
  MIN_CIPHERTEXT_CHARS,
  ROUTES,
  TTL_SECONDS,
  type ApiErrorCode,
  type CreateTicketRequest,
  type CreateTicketResponse,
} from "../../src/shared/protocol";
import handler from "../../src/worker/index";
import type { SecretBox } from "../../src/worker/secret-box";

const BASE_URL = "https://snapkey.test";
const VALID_ID = "AbCdEfGhIjKlMnOpQrStUv";
const VALID_IV = "AbCdEfGhIjKlMnOp";
const VALID_CIPHERTEXT = "AbCdEfGhIjKlMnOpQrStUvWx";
const SECRET_BYTES = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const CLAIM_SECRET = base64Url(SECRET_BYTES);
const WRONG_SECRET = base64Url(new Uint8Array(32));
const worker = (exports as { default: Fetcher }).default;
let claimHash: string;
let testNumber = 0;
let clientIp: string;

beforeEach(async () => {
  clientIp = `192.0.2.${++testNumber}`;
  claimHash = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", SECRET_BYTES)));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await reset();
});

describe("ticket lifecycle", () => {
  it("creates, checks status repeatedly, claims once, and returns matching data", async () => {
    const created = await createTicket();
    expect(created.expiresAt).toBeGreaterThan(Date.now());
    for (let i = 0; i < 2; i++) {
      const status = await api(ROUTES.status(VALID_ID), { claimSecret: CLAIM_SECRET });
      expect(status.status).toBe(200);
      await expect(status.json()).resolves.toEqual(created);
    }
    const claim = await api(ROUTES.claim(VALID_ID), { claimSecret: CLAIM_SECRET });
    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toEqual({ ciphertext: VALID_CIPHERTEXT, iv: VALID_IV });
    await expectError(await api(ROUTES.claim(VALID_ID), { claimSecret: CLAIM_SECRET }), "not_found");
    await expectError(await api(ROUTES.status(VALID_ID), { claimSecret: CLAIM_SECRET }), "not_found");
  });

  it("makes wrong proofs indistinguishable from missing tickets without consuming", async () => {
    await createTicket();
    const missingId = "Z".repeat(22);
    for (const route of [ROUTES.status, ROUTES.claim]) {
      const wrong = await api(route(VALID_ID), { claimSecret: WRONG_SECRET });
      const missing = await api(route(missingId), { claimSecret: WRONG_SECRET });
      expect(wrong.status).toBe(missing.status);
      expect([...wrong.headers]).toEqual([...missing.headers]);
      await expectError(wrong, "not_found");
      await expectError(missing, "not_found");
    }
    expect((await api(ROUTES.claim(VALID_ID), { claimSecret: CLAIM_SECRET })).status).toBe(200);
  });

  it("rejects id-only and malformed proofs on status and claim without consuming", async () => {
    await createTicket();
    for (const route of [ROUTES.status, ROUTES.claim]) {
      for (const proof of [{}, { claimSecret: "short" }, { claimSecret: 123 }, null]) {
        await expectError(await api(route(VALID_ID), proof), "invalid_request");
      }
    }
    expect((await api(ROUTES.claim(VALID_ID), { claimSecret: CLAIM_SECRET })).status).toBe(200);
  });

  it("blocks duplicate live ids and preserves the original ciphertext", async () => {
    await createTicket();
    await expectError(
      await api(ROUTES.create, validCreateBody({ ciphertext: "Z".repeat(24) })),
      "exists",
    );
    const claim = await api(ROUTES.claim(VALID_ID), { claimSecret: CLAIM_SECRET });
    await expect(claim.json()).resolves.toEqual({ ciphertext: VALID_CIPHERTEXT, iv: VALID_IV });
  });

  it("keeps a consumed id reserved until its original expiry", async () => {
    const created = await createTicket();
    expect((await api(ROUTES.claim(VALID_ID), { claimSecret: CLAIM_SECRET })).status).toBe(200);
    await expectError(await api(ROUTES.create, validCreateBody()), "exists");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(created.expiresAt - 1);
    await expectError(await api(ROUTES.create, validCreateBody()), "exists");
    vi.setSystemTime(created.expiresAt);
    const response = await api(ROUTES.create, validCreateBody());
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      expiresAt: created.expiresAt + TTL_SECONDS[0] * 1000,
    });
    expect((await api(ROUTES.claim(VALID_ID), { claimSecret: CLAIM_SECRET })).status).toBe(200);
  });

  it("replaces an expired live record before its alarm runs", async () => {
    const created = await createTicket();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(created.expiresAt);
    expect((await api(ROUTES.create, validCreateBody({ ciphertext: "Z".repeat(24) }))).status).toBe(201);
    const claim = await api(ROUTES.claim(VALID_ID), { claimSecret: CLAIM_SECRET });
    await expect(claim.json()).resolves.toEqual({ ciphertext: "Z".repeat(24), iv: VALID_IV });
  });

  it.each(["status", "claim"] as const)("treats expired tickets as missing on %s", async (action) => {
    const created = await createTicket();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(created.expiresAt);
    await expectError(await api(ROUTES[action](VALID_ID), { claimSecret: CLAIM_SECRET }), "not_found");
    expect((await api(ROUTES.create, validCreateBody())).status).toBe(201);
  });

  it.each([false, true])("alarm removes the record and reservation, consumed=%s", async (consumed) => {
    const created = await createTicket();
    if (consumed) await api(ROUTES.claim(VALID_ID), { claimSecret: CLAIM_SECRET });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(created.expiresAt);
    const stub = getStub();
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(stub.status(CLAIM_SECRET)).resolves.toBeNull();
    await expect(stub.claim(CLAIM_SECRET)).resolves.toBeNull();
    expect((await api(ROUTES.create, validCreateBody())).status).toBe(201);
    expect((await api(ROUTES.status(VALID_ID), { claimSecret: CLAIM_SECRET })).status).toBe(200);
  });

  it("a delayed old alarm preserves the replacement and its expiry cleanup", async () => {
    const created = await createTicket();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(created.expiresAt);
    const replacement = await createTicket();
    await expect(runDurableObjectAlarm(getStub())).resolves.toBe(true);
    const status = await api(ROUTES.status(VALID_ID), { claimSecret: CLAIM_SECRET });
    await expect(status.json()).resolves.toEqual(replacement);
    vi.setSystemTime(replacement.expiresAt);
    await expect(runDurableObjectAlarm(getStub())).resolves.toBe(true);
    await expect(getStub().claim(CLAIM_SECRET)).resolves.toBeNull();
    expect((await api(ROUTES.create, validCreateBody())).status).toBe(201);
  });

  it("wrong proofs never clear an expired record's scheduled alarm", async () => {
    const created = await createTicket();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(created.expiresAt);
    for (const route of [ROUTES.status, ROUTES.claim]) {
      await expectError(await api(route(VALID_ID), { claimSecret: WRONG_SECRET }), "not_found");
    }
    await expect(runDurableObjectAlarm(getStub())).resolves.toBe(true);
  });

  it("allows exactly one of 40 concurrent claims", async () => {
    await createTicket();
    const responses = await Promise.all(
      Array.from({ length: 40 }, () => api(ROUTES.claim(VALID_ID), { claimSecret: CLAIM_SECRET })),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 404)).toHaveLength(39);
    for (const response of responses.filter((response) => response.status === 404)) {
      await expectError(response, "not_found");
    }
  });

  it("supports the public RPC lifecycle and rejects wrong proofs", async () => {
    const { id: _id, ...ticket } = validCreateBody();
    const stub = getStub();
    const created = await stub.store(ticket);
    expect(created).toEqual({ expiresAt: expect.any(Number) });
    await expect(stub.status(WRONG_SECRET)).resolves.toBeNull();
    await expect(stub.claim(WRONG_SECRET)).resolves.toBeNull();
    await expect(stub.status(CLAIM_SECRET)).resolves.toEqual(created);
    await expect(stub.claim(CLAIM_SECRET)).resolves.toEqual({
      ciphertext: VALID_CIPHERTEXT,
      iv: VALID_IV,
    });
    await expect(stub.store(ticket)).resolves.toBe("exists");
    await expect(stub.claim(CLAIM_SECRET)).resolves.toBeNull();
  });
});

describe("request validation", () => {
  it("rejects invalid create fields and malformed JSON values", async () => {
    const cases: unknown[] = [
      validCreateBody({ id: "short" }),
      validCreateBody({ id: "A".repeat(23) }),
      validCreateBody({ iv: "short" }),
      validCreateBody({ iv: "A".repeat(17) }),
      validCreateBody({ ciphertext: "has+padding=" }),
      validCreateBody({ ciphertext: "A".repeat(MIN_CIPHERTEXT_CHARS - 1) }),
      validCreateBody({ ciphertext: "A".repeat(MAX_CIPHERTEXT_CHARS + 1) }),
      { ...validCreateBody(), ttlSeconds: 123 },
      { ...validCreateBody(), ttlSeconds: "300" },
      validCreateBody({ claimHash: "short" }),
      validCreateBody({ claimHash: "+".repeat(43) }),
      validCreateBody({ claimHash: "A".repeat(44) }),
      { ...validCreateBody(), claimHash: undefined },
      [],
      null,
    ];
    for (const body of cases) await expectError(await api(ROUTES.create, body), "invalid_request");
  });

  it.each([MIN_CIPHERTEXT_CHARS, MAX_CIPHERTEXT_CHARS])(
    "accepts the ciphertext boundary of %s characters",
    async (length) => {
      expect((await api(ROUTES.create, validCreateBody({ ciphertext: "A".repeat(length) }))).status).toBe(201);
    },
  );

  it.each(TTL_SECONDS)("accepts the contract TTL %s", async (ttlSeconds) => {
    expect((await api(ROUTES.create, validCreateBody({ ttlSeconds }))).status).toBe(201);
  });

  it.each([ROUTES.create, ROUTES.status(VALID_ID), ROUTES.claim(VALID_ID)])(
    "requires JSON content type on %s",
    async (route) => {
      for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""]) {
        await expectError(await api(route, validCreateBody(), { "Content-Type": contentType }), "invalid_request");
      }
    },
  );

  it("rejects an absent JSON content type on every route without consuming", async () => {
    await createTicket();
    for (const route of [ROUTES.create, ROUTES.status(VALID_ID), ROUTES.claim(VALID_ID)]) {
      // A byte body avoids Request automatically adding a text/plain content type.
      const body = new TextEncoder().encode(JSON.stringify({ claimSecret: CLAIM_SECRET }));
      await expectError(await worker.fetch(new Request(`${BASE_URL}${route}`, {
        method: "POST",
        headers: { "CF-Connecting-IP": clientIp },
        body,
      })), "invalid_request");
    }
    expect((await api(ROUTES.claim(VALID_ID), { claimSecret: CLAIM_SECRET })).status).toBe(200);
  });

  it("rejects malformed JSON, empty bodies and invalid route ids", async () => {
    for (const body of ["{", ""]) {
      await expectError(await worker.fetch(new Request(`${BASE_URL}${ROUTES.create}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
        body,
      })), "invalid_request");
    }
    for (const route of [ROUTES.status, ROUTES.claim]) {
      await expectError(await api(route("invalid"), { claimSecret: CLAIM_SECRET }), "invalid_request");
    }
  });

  it.each([String(MAX_REQUEST_BYTES + 1), "9007199254740992", "9".repeat(400)])(
    "rejects declared oversized bodies without pulling the body, length=%s",
    async (contentLength) => {
      let pulls = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(1));
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const request = new Request(`${BASE_URL}${ROUTES.create}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": clientIp,
          "Content-Length": contentLength,
        },
        body: stream,
      });
      await expectError(await handler.fetch(request, env), "too_large");
      expect(pulls).toBe(0);
      expect(cancelled).toBe(false);
      await stream.cancel();
    },
  );

  it.each([ROUTES.create, ROUTES.status(VALID_ID), ROUTES.claim(VALID_ID)])(
    "caps chunked bodies on %s and cancels at the first overflowing chunk",
    async (route) => {
      const chunk = new Uint8Array(MAX_REQUEST_BYTES / 4);
      let sent = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent++;
          controller.enqueue(chunk);
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const request = new Request(`${BASE_URL}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
        body: stream,
      });
      await expectError(await handler.fetch(request, env), "too_large");
      expect(sent).toBe(5);
      expect(cancelled).toBe(true);
    },
  );

  it("accepts a valid JSON body at the byte cap and rejects cap plus one", async () => {
    const body = JSON.stringify(validCreateBody());
    for (const extra of [0, 1]) {
      const request = new Request(`${BASE_URL}${ROUTES.create}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
        body: body + " ".repeat(MAX_REQUEST_BYTES - body.length + extra),
      });
      const response = await worker.fetch(request);
      if (extra === 0) expect(response.status).toBe(201);
      else await expectError(response, "too_large");
    }
  });
});

describe("cross-site and abuse guards", () => {
  it.each([ROUTES.create, ROUTES.status(VALID_ID), ROUTES.claim(VALID_ID)])(
    "rejects cross-site requests on %s",
    async (route) => {
      await createTicket();
      const body = route === ROUTES.create ? validCreateBody() : { claimSecret: CLAIM_SECRET };
      const blockedHeaders: Record<string, string>[] = [
        { "Sec-Fetch-Site": "cross-site" },
        { "Sec-Fetch-Site": "same-site" },
        { "Sec-Fetch-Site": "" },
        { Origin: "https://attacker.test" },
        { Origin: "null" },
        { Origin: "https://snapkey.test:444" },
        { "Sec-Fetch-Site": "same-origin", Origin: "https://attacker.test" },
      ];
      for (const headers of blockedHeaders) {
        await expectError(await api(route, body, headers), "forbidden");
      }
      expect((await api(ROUTES.claim(VALID_ID), { claimSecret: CLAIM_SECRET })).status).toBe(200);
    },
  );

  it.each(["same-origin", "none"])("allows Sec-Fetch-Site %s with matching Origin", async (site) => {
    const headers = { "Sec-Fetch-Site": site, Origin: BASE_URL };
    expect((await api(ROUTES.create, validCreateBody(), headers)).status).toBe(201);
    expect((await api(ROUTES.status(VALID_ID), { claimSecret: CLAIM_SECRET }, headers)).status).toBe(200);
    expect((await api(ROUTES.claim(VALID_ID), { claimSecret: CLAIM_SECRET }, headers)).status).toBe(200);
  });

  it("rate limits create after 30 calls and checks the limiter before body reads", async () => {
    await fillCreateBucket(clientIp);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(1)); },
    }, { highWaterMark: 0 });
    const request = new Request(`${BASE_URL}${ROUTES.create}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
      body: stream,
    });
    await expectError(await handler.fetch(request, env), "rate_limited");
    expect(pulls).toBe(0);
    await stream.cancel();
    expect((await api(ROUTES.status(VALID_ID), { claimSecret: CLAIM_SECRET })).status).toBe(200);
    await expectError(await api(ROUTES.create, validCreateBody(), {
      "CF-Connecting-IP": "198.51.100.1",
    }), "exists");
  });

  it("uses the unknown bucket when CF-Connecting-IP is absent", async () => {
    await driveUntilLimited(
      () =>
        worker.fetch(new Request(`${BASE_URL}${ROUTES.create}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validCreateBody()),
        })),
      [201, 409],
    );
    await expectError(await api(ROUTES.create, validCreateBody(), {
      "CF-Connecting-IP": "unknown",
    }), "rate_limited");
  });

  it.each([
    ["2001:DB8::1", "2001:0db8:0000:0000:ffff::2", "2001:db8:0:1::1"],
    ["2001:db8:abcd:1234::1", "2001:DB8:abcd:1234:ffff:eeee:dddd:cccc", "2001:db8:abcd:1235::1"],
    // IPv4-mapped IPv6 is the IPv4 client it maps, not one /64 shared by every IPv4 client.
    ["::ffff:192.0.2.1", "192.0.2.1", "::ffff:192.0.2.2"],
    ["0:0:0:0:0:ffff:c000:201", "::FFFF:192.0.2.1", "0:0:0:0:0:ffff:c000:202"],
  ])("shares a bucket for %s and %s but not %s", async (first, same, different) => {
    await fillCreateBucket(first);
    await expectError(
      await api(ROUTES.create, validCreateBody(), { "CF-Connecting-IP": same }),
      "rate_limited",
    );
    await expectError(
      await api(ROUTES.create, validCreateBody(), { "CF-Connecting-IP": different }),
      "exists",
    );
  });

  it("shares READ_LIMITER between status and claim and rejects before pulling", async () => {
    await createTicket();
    await driveUntilLimited(
      (i) => api((i % 2 ? ROUTES.claim : ROUTES.status)(VALID_ID), { claimSecret: WRONG_SECRET }),
      [404],
    );
    for (const route of [ROUTES.status, ROUTES.claim]) {
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) { pulls++; controller.enqueue(new Uint8Array(1)); },
      }, { highWaterMark: 0 });
      await expectError(await handler.fetch(new Request(`${BASE_URL}${route(VALID_ID)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
        body: stream,
      }), env), "rate_limited");
      expect(pulls).toBe(0);
      await stream.cancel();
    }
    await expect(getStub().claim(CLAIM_SECRET)).resolves.toEqual({
      ciphertext: VALID_CIPHERTEXT, iv: VALID_IV,
    });
    // 120+ sequential round trips, each hashing a proof: too slow for the 5s default under load.
  }, 30_000);
});

describe("response contract", () => {
  it("returns a redacted 500 and logs only a fixed message and error name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("sensitive request body must never be logged"));
      },
    }, { highWaterMark: 0 });
    const response = await handler.fetch(new Request(`${BASE_URL}${ROUTES.create}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
      body: stream,
    }), env);
    await expectError(response, "internal");
    expect(log.mock.calls).toEqual([["ticket_api_error", "TypeError"]]);
  });

  it("returns 404 for unknown routes and every old secrets route", async () => {
    for (const route of ["/api/nope", "/api/secrets", `/api/secrets/${VALID_ID}`, `/api/secrets/${VALID_ID}/claim`]) {
      await expectError(await api(route, {}), "not_found");
    }
  });

  it("returns 405 with Allow POST for every known route", async () => {
    for (const route of [ROUTES.create, ROUTES.status(VALID_ID), ROUTES.claim(VALID_ID)]) {
      for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
        const response = await worker.fetch(new Request(`${BASE_URL}${route}`, { method }));
        expect(response.headers.get("Allow")).toBe("POST");
        await expectError(response, "method_not_allowed");
      }
    }
  });

  it("sets standard headers on successful create, status and claim", async () => {
    const create = await api(ROUTES.create, validCreateBody());
    expect(create.status).toBe(201);
    expectHeaders(create);
    for (const route of [ROUTES.status, ROUTES.claim]) {
      const response = await api(route(VALID_ID), { claimSecret: CLAIM_SECRET });
      expect(response.status).toBe(200);
      expectHeaders(response);
    }
  });
});

async function createTicket(): Promise<CreateTicketResponse> {
  const response = await api(ROUTES.create, validCreateBody());
  expect(response.status).toBe(201);
  return response.json<CreateTicketResponse>();
}

function validCreateBody(overrides: Partial<CreateTicketRequest> = {}): CreateTicketRequest {
  return {
    id: VALID_ID,
    claimHash,
    ciphertext: VALID_CIPHERTEXT,
    iv: VALID_IV,
    ttlSeconds: TTL_SECONDS[0],
    ...overrides,
  };
}

function getStub(): DurableObjectStub<SecretBox> {
  return env.SECRET_BOX.get(env.SECRET_BOX.idFromName(VALID_ID));
}

async function api(
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return worker.fetch(new Request(`${BASE_URL}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp, ...headers },
    body: JSON.stringify(body),
  }));
}

/**
 * Sends until the limiter answers 429. The limiter counts in fixed one-minute windows, so a
 * fixed request count is flaky: a window can roll over mid-test and reset the count.
 */
async function driveUntilLimited(
  send: (i: number) => Promise<Response>,
  allowedBeforeLimit: number[],
  max = 300,
): Promise<void> {
  for (let i = 0; i < max; i++) {
    const response = await send(i);
    if (response.status === API_ERRORS.rate_limited) return;
    expect(allowedBeforeLimit).toContain(response.status);
  }
  throw new Error(`no rate limit after ${max} requests`);
}

async function fillCreateBucket(ip: string): Promise<void> {
  await driveUntilLimited(
    () => api(ROUTES.create, validCreateBody(), { "CF-Connecting-IP": ip }),
    [201, 409],
  );
}

async function expectError(response: Response, error: ApiErrorCode): Promise<void> {
  expect(response.status).toBe(API_ERRORS[error]);
  expectHeaders(response);
  await expect(response.json()).resolves.toEqual({ error });
}

function expectHeaders(response: Response): void {
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
