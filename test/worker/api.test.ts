import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_REQUEST_BYTES, TTL_OPTIONS } from "../../src/shared/protocol";
import { type SecretBox, type SecretRecord } from "../../src/worker/secret-box";

const BASE_URL = "https://snapkey.test";
const VALID_ID = "AbCdEfGhIjKlMnOpQrStUv";
const VALID_IV = "AbCdEfGhIjKlMnOp";
const VALID_CIPHERTEXT = "AbCdEfGhIjKlMnOpQrStUvWx";
const TTL_SECONDS = TTL_OPTIONS[0].seconds;
const worker = (exports as { default: Fetcher }).default;

afterEach(async () => {
  await reset();
});

describe("worker API", () => {
  it("creates, reports status, claims once, and then removes the secret", async () => {
    const create = await api("/api/secrets", {
      method: "POST",
      body: validCreateBody(),
    });

    expect(create.status).toBe(201);
    expect(create.headers.get("Cache-Control")).toBe("no-store");

    const created = await create.json<{ expiresAt: number }>();
    expect(created.expiresAt).toBeGreaterThan(Date.now());

    const status = await api(`/api/secrets/${VALID_ID}`);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({ expiresAt: created.expiresAt });

    const claim = await api(`/api/secrets/${VALID_ID}/claim`, { method: "POST" });
    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toEqual({
      ciphertext: VALID_CIPHERTEXT,
      iv: VALID_IV,
    });

    const secondClaim = await api(`/api/secrets/${VALID_ID}/claim`, { method: "POST" });
    expect(secondClaim.status).toBe(404);
    await expect(secondClaim.json()).resolves.toEqual({ error: "not_found" });

    const missingStatus = await api(`/api/secrets/${VALID_ID}`);
    expect(missingStatus.status).toBe(404);
    await expect(missingStatus.json()).resolves.toEqual({ error: "not_found" });
  });

  it("does not consume a secret when reading status", async () => {
    await createSecret();

    expect((await api(`/api/secrets/${VALID_ID}`)).status).toBe(200);
    expect((await api(`/api/secrets/${VALID_ID}`)).status).toBe(200);

    const claim = await api(`/api/secrets/${VALID_ID}/claim`, { method: "POST" });

    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toEqual({
      ciphertext: VALID_CIPHERTEXT,
      iv: VALID_IV,
    });
  });

  it("rejects invalid create requests", async () => {
    const cases = [
      { id: "short", ciphertext: VALID_CIPHERTEXT, iv: VALID_IV, ttlSeconds: TTL_SECONDS },
      { id: VALID_ID, ciphertext: VALID_CIPHERTEXT, iv: "short", ttlSeconds: TTL_SECONDS },
      { id: VALID_ID, ciphertext: "has+padding=", iv: VALID_IV, ttlSeconds: TTL_SECONDS },
      { id: VALID_ID, ciphertext: "short", iv: VALID_IV, ttlSeconds: TTL_SECONDS },
      { id: VALID_ID, ciphertext: VALID_CIPHERTEXT, iv: VALID_IV, ttlSeconds: 123 },
    ];

    for (const body of cases) {
      const response = await api("/api/secrets", { method: "POST", body });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    }
  });

  it("rejects non-json and oversized create bodies", async () => {
    const nonJson = await worker.fetch(
      new Request(`${BASE_URL}/api/secrets`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not json",
      }),
    );

    expect(nonJson.status).toBe(400);

    const oversized = await worker.fetch(
      new Request(`${BASE_URL}/api/secrets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(MAX_REQUEST_BYTES + 1),
      }),
    );

    expect(oversized.status).toBe(413);

    const oversizedByHeader = await worker.fetch(
      new Request(`${BASE_URL}/api/secrets`, {
        method: "POST",
        headers: {
          "Content-Length": String(MAX_REQUEST_BYTES + 1),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(validCreateBody()),
      }),
    );

    expect(oversizedByHeader.status).toBe(413);

    // Chunked upload with no Content-Length: the cap has to hold while streaming.
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const chunked = await worker.fetch(
      new Request(`${BASE_URL}/api/secrets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stream,
      }),
    );

    expect(chunked.status).toBe(413);
  });

  it("accepts the shortest real ciphertext and rejects a bare tag", async () => {
    // One plaintext byte plus the 16-byte GCM tag is 23 base64url chars.
    const oneByte = await api("/api/secrets", {
      method: "POST",
      body: validCreateBody({ ciphertext: "A".repeat(23) }),
    });
    expect(oneByte.status).toBe(201);

    const tagOnly = await api("/api/secrets", {
      method: "POST",
      body: validCreateBody({ id: "ZyXwVuTsRqPoNmLkJiHgFe", ciphertext: "A".repeat(22) }),
    });
    expect(tagOnly.status).toBe(400);
  });

  it("does not overwrite a live secret with the same id", async () => {
    await createSecret();

    const duplicate = await api("/api/secrets", {
      method: "POST",
      body: validCreateBody({ ciphertext: "ZbCdEfGhIjKlMnOpQrStUvWx" }),
    });

    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({ error: "already_exists" });

    const claim = await api(`/api/secrets/${VALID_ID}/claim`, { method: "POST" });

    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toEqual({
      ciphertext: VALID_CIPHERTEXT,
      iv: VALID_IV,
    });
  });

  it("treats expired records as missing", async () => {
    await createSecret();
    await expireSecret(VALID_ID);

    const status = await api(`/api/secrets/${VALID_ID}`);
    expect(status.status).toBe(404);
    await expect(status.json()).resolves.toEqual({ error: "not_found" });

    await createSecret();
    await expireSecret(VALID_ID);

    const claim = await api(`/api/secrets/${VALID_ID}/claim`, { method: "POST" });
    expect(claim.status).toBe(404);
    await expect(claim.json()).resolves.toEqual({ error: "not_found" });
  });

  it("deletes storage when the alarm runs", async () => {
    await createSecret();

    const stub = getStub(VALID_ID);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const stored = await runInDurableObject(stub, async (_instance, state) => {
      return state.storage.get<SecretRecord>("record");
    });

    expect(stored).toBeUndefined();
  });

  it("allows only one concurrent claim to win", async () => {
    await createSecret();

    const claims = await Promise.all([
      api(`/api/secrets/${VALID_ID}/claim`, { method: "POST" }),
      api(`/api/secrets/${VALID_ID}/claim`, { method: "POST" }),
    ]);
    const statuses = claims.map((response) => response.status).sort();

    expect(statuses).toEqual([200, 404]);
  });

  it("returns not found for invalid ids and unknown routes", async () => {
    const invalidStatus = await api("/api/secrets/not-valid");
    expect(invalidStatus.status).toBe(404);
    await expect(invalidStatus.json()).resolves.toEqual({ error: "not_found" });

    const invalidClaim = await api("/api/secrets/not-valid/claim", { method: "POST" });
    expect(invalidClaim.status).toBe(404);
    await expect(invalidClaim.json()).resolves.toEqual({ error: "not_found" });

    const unknown = await api("/api/nope");
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({ error: "not_found" });
  });

  it("returns method not allowed with Allow on known routes", async () => {
    const createWrongMethod = await api("/api/secrets");
    expect(createWrongMethod.status).toBe(405);
    expect(createWrongMethod.headers.get("Allow")).toBe("POST");

    const statusWrongMethod = await api(`/api/secrets/${VALID_ID}`, { method: "POST" });
    expect(statusWrongMethod.status).toBe(405);
    expect(statusWrongMethod.headers.get("Allow")).toBe("GET");

    const claimWrongMethod = await api(`/api/secrets/${VALID_ID}/claim`);
    expect(claimWrongMethod.status).toBe(405);
    expect(claimWrongMethod.headers.get("Allow")).toBe("POST");
  });
});

async function createSecret(): Promise<Response> {
  const response = await api("/api/secrets", {
    method: "POST",
    body: validCreateBody(),
  });

  expect(response.status).toBe(201);

  return response;
}

async function expireSecret(id: string): Promise<void> {
  const stub = getStub(id);

  await runInDurableObject(stub, async (_instance, state) => {
    const record = await state.storage.get<SecretRecord>("record");

    if (!record) {
      throw new Error("expected stored record");
    }

    await state.storage.put<SecretRecord>("record", {
      ...record,
      expiresAt: Date.now() - 1,
    });
  });
}

function getStub(id: string): DurableObjectStub<SecretBox> {
  return env.SECRET_BOX.get(env.SECRET_BOX.idFromName(id));
}

function validCreateBody(overrides: Partial<SecretRecord & { id: string; ttlSeconds: number }> = {}) {
  return {
    id: VALID_ID,
    ciphertext: VALID_CIPHERTEXT,
    iv: VALID_IV,
    ttlSeconds: TTL_SECONDS,
    ...overrides,
  };
}

async function api(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return worker.fetch(
    new Request(`${BASE_URL}${path}`, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}
