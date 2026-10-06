import { describe, expect, it } from "vitest";
import { createTicketApi, type Transport } from "../../src/client/api";

const ID = "AbCdEfGhIjKlMnOpQrStUv";
const PROOF = { claimSecret: "A".repeat(43) };
const CREATE = { id: ID, claimHash: "B".repeat(43), ciphertext: "C".repeat(30), iv: "D".repeat(16), ttlSeconds: 3600 as const };
const SEALED = { ciphertext: "C".repeat(30), iv: "D".repeat(16) };

const reply =
  (status: number, body: unknown): Transport =>
  async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const offline: Transport = async () => {
  throw new TypeError("Failed to fetch");
};

describe("create", () => {
  it("returns expiresAt on 201", async () => {
    expect(await createTicketApi(reply(201, { expiresAt: 123 })).create(CREATE)).toEqual({ ok: true, value: { expiresAt: 123 } });
  });
  it.each([
    [429, { error: "rate_limited" }, "rate_limited"],
    [413, { error: "too_large" }, "too_large"],
    [400, { error: "invalid_request" }, "server"],
    [409, { error: "exists" }, "exists"],
    [201, { expiresAt: "soon" }, "server"],
    [201, "not json", "server"],
    [502, "<html>bad gateway</html>", "server"],
  ])("maps %i %j to %s", async (status, body, failure) => {
    expect(await createTicketApi(reply(status, body)).create(CREATE)).toEqual({ ok: false, failure });
  });
  it("reports network when nothing comes back", async () => {
    expect(await createTicketApi(offline).create(CREATE)).toEqual({ ok: false, failure: "network" });
  });
});

describe("status", () => {
  it.each([
    [200, { expiresAt: 5 }, { ok: true, value: { expiresAt: 5 } }],
    [404, { error: "not_found" }, { ok: false, failure: "not_found" }],
    [429, { error: "rate_limited" }, { ok: false, failure: "rate_limited" }],
    [403, { error: "forbidden" }, { ok: false, failure: "server" }],
  ])("maps %i", async (status, body, expected) => {
    expect(await createTicketApi(reply(status, body)).status(ID, PROOF)).toEqual(expected);
  });
});

describe("claim", () => {
  it("returns the sealed ticket on 200", async () => {
    expect(await createTicketApi(reply(200, SEALED)).claim(ID, PROOF)).toEqual({ ok: true, value: SEALED });
  });
  it.each([
    [404, { error: "not_found" }, "not_found"],
    [429, { error: "rate_limited" }, "rate_limited"],
    [400, { error: "invalid_request" }, "server"],
    // The server deletes before answering 200, so an unreadable 200 may have lost the ticket.
    [200, { ciphertext: "!!" }, "uncertain"],
    [200, "truncated", "uncertain"],
    [500, { error: "internal" }, "uncertain"],
  ])("maps %i %j to %s", async (status, body, failure) => {
    expect(await createTicketApi(reply(status, body)).claim(ID, PROOF)).toEqual({ ok: false, failure });
  });
  it("treats no response as uncertain, not as a clean failure", async () => {
    expect(await createTicketApi(offline).claim(ID, PROOF)).toEqual({ ok: false, failure: "uncertain" });
  });
});

describe("transport", () => {
  it("posts JSON to contract routes, uncached", async () => {
    const seen: { path: string; init: RequestInit }[] = [];
    const spy: Transport = async (path, init) => {
      seen.push({ path, init });
      return new Response(JSON.stringify({ expiresAt: 1 }), { status: 200 });
    };
    await createTicketApi(spy).status(ID, PROOF);
    expect(seen[0]?.path).toBe(`/api/tickets/${ID}/status`);
    expect(seen[0]?.init).toMatchObject({ method: "POST", cache: "no-store" });
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual(PROOF);
  });

  it("gives up after the timeout", async () => {
    const hang: Transport = (_path, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    expect(await createTicketApi(hang, 20).status(ID, PROOF)).toEqual({ ok: false, failure: "network" });
    expect(await createTicketApi(hang, 20).claim(ID, PROOF)).toEqual({ ok: false, failure: "uncertain" });
  });
});
