import { describe, expect, it } from "vitest";
import {
  inspectTicket,
  issueTicket,
  parseTicketFragment,
  revealTicket,
  ticketLink,
  type TicketCapability,
  type Transport,
} from "../../src/core/ticket";
import { generateIdentity, unlockTicketKey } from "../../src/core/lock";
import { MAX_PLAINTEXT_BYTES } from "../../src/shared/protocol";

const KEY = "k".repeat(43);

describe("parseTicketFragment", () => {
  it.each([
    ["", "missing"],
    ["#", "missing"],
    [`#v1.${KEY}`, "ticket"],
    [`v1.${KEY}`, "ticket"],
    [`#v1.${KEY.slice(1)}`, "malformed"],
    [`#v1.${KEY}x`, "malformed"],
    [`#${KEY}`, "malformed"],
    [`#v1.${KEY.slice(0, 42)}+`, "malformed"],
    [`#v2.${"e".repeat(43)}.${"w".repeat(80)}`, "locked"],
    [`#v2.${"e".repeat(43)}.${"w".repeat(79)}`, "malformed"],
    [`#v2.${KEY}`, "malformed"],
    [`#v3.${KEY}`, "unsupported_version"],
  ])("reads %j as %s", (fragment, kind) => {
    expect(parseTicketFragment(fragment).kind).toBe(kind);
  });

  it("round-trips through ticketLink", () => {
    const link = ticketLink("https://stubs.talix.app", KEY as TicketCapability);
    expect(link).toBe(`https://stubs.talix.app/t#v1.${KEY}`);
    expect(parseTicketFragment(new URL(link).hash)).toEqual({ kind: "ticket", capability: KEY });
  });
});

/** A tiny in-memory server that follows the contract, recording everything sent to it. */
function fakeServer() {
  const store = new Map<string, { claimHash: string; ciphertext: string; iv: string }>();
  const sent: string[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const hash = async (secret: string) => {
    const bytes = Uint8Array.from(atob(secret.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const transport: Transport = async (path, init) => {
    sent.push(path, String(init.body), JSON.stringify(init.headers ?? {}));
    const body = JSON.parse(String(init.body));
    if (path === "/api/tickets") {
      store.set(body.id, body);
      return json(201, { expiresAt: 42 });
    }
    const [, id, action] = /^\/api\/tickets\/([^/]+)\/(status|claim)$/.exec(path) ?? [];
    const record = store.get(id ?? "");
    if (!record || record.claimHash !== (await hash(body.claimSecret))) return json(404, { error: "not_found" });
    if (action === "status") return json(200, { expiresAt: 42 });
    store.delete(id!);
    return json(200, { ciphertext: record.ciphertext, iv: record.iv });
  };
  return { transport, sent, store };
}

describe("ticket lifecycle", () => {
  const text = "API_KEY=abc123\nDB=postgres://x";

  it("issues, inspects, and reveals once", async () => {
    const server = fakeServer();
    const issued = await issueTicket(text, 3600, server.transport, "https://x.test");
    if (issued.kind !== "issued") throw new Error(issued.reason);
    const reading = parseTicketFragment(new URL(issued.link).hash);
    if (reading.kind !== "ticket") throw new Error(reading.kind);

    expect(await inspectTicket(reading.capability, server.transport)).toEqual({ kind: "sealed", expiresAt: 42 });
    expect(await revealTicket(reading.capability, server.transport)).toEqual({ kind: "opened", plaintext: text });
    expect(await revealTicket(reading.capability, server.transport)).toEqual({ kind: "void" });
    expect(await inspectTicket(reading.capability, server.transport)).toEqual({ kind: "void" });
  });

  it("never sends the key or the plaintext to the server", async () => {
    const server = fakeServer();
    const issued = await issueTicket(text, 3600, server.transport, "https://x.test");
    if (issued.kind !== "issued") throw new Error(issued.reason);
    const reading = parseTicketFragment(new URL(issued.link).hash);
    if (reading.kind !== "ticket") throw new Error(reading.kind);
    await inspectTicket(reading.capability, server.transport);
    await revealTicket(reading.capability, server.transport);

    const wire = server.sent.join("\n");
    expect(wire).not.toContain(reading.capability);
    expect(wire).not.toContain("abc123");
    expect(wire).not.toContain("postgres");
  });

  it("can't be opened with a different key", async () => {
    const server = fakeServer();
    await issueTicket(text, 3600, server.transport, "https://x.test");
    expect(await revealTicket(KEY as TicketCapability, server.transport)).toEqual({ kind: "void" });
    expect(server.store.size).toBe(1);
  });

  it("reports tampering after a successful claim", async () => {
    const server = fakeServer();
    const issued = await issueTicket(text, 3600, server.transport, "https://x.test");
    if (issued.kind !== "issued") throw new Error(issued.reason);
    const reading = parseTicketFragment(new URL(issued.link).hash);
    if (reading.kind !== "ticket") throw new Error(reading.kind);
    const record = [...server.store.values()][0]!;
    record.ciphertext = (record.ciphertext[0] === "A" ? "B" : "A") + record.ciphertext.slice(1);
    expect(await revealTicket(reading.capability, server.transport)).toEqual({ kind: "tampered" });
  });

  it("locks a stub to a recipient, who alone can unwrap and open it", async () => {
    const server = fakeServer();
    const recipient = await generateIdentity();
    const issued = await issueTicket(text, 3600, server.transport, "https://x.test", { lockTo: recipient.publicId });
    if (issued.kind !== "issued") throw new Error(issued.reason);

    const url = new URL(issued.link);
    expect(url.hash.startsWith("#v2.")).toBe(true);
    const body = url.hash.slice("#v2.".length);
    expect(await unlockTicketKey(body, await generateIdentity())).toBeNull();
    const key = await unlockTicketKey(body, recipient);
    expect(key).not.toBeNull();
    expect(await revealTicket(key as TicketCapability, server.transport)).toEqual({ kind: "opened", plaintext: text });
    expect(server.sent.join("\n")).not.toContain(key);
  });

  it("reports a degenerate recipient id without creating anything", async () => {
    const server = fakeServer();
    // All-zero X25519 point: passes the pattern, but no shared secret can be derived from it.
    const zeroPoint = "stubs1" + "A".repeat(43);
    expect(await issueTicket(text, 3600, server.transport, "x", { lockTo: zeroPoint })).toEqual({
      kind: "failed",
      reason: "bad_recipient",
    });
    expect(server.sent).toHaveLength(0);
  });

  it("refuses an unvalidated recipient id before doing anything", async () => {
    const server = fakeServer();
    await expect(issueTicket(text, 3600, server.transport, "x", { lockTo: "stubs1nope" })).rejects.toThrow();
    expect(server.sent).toHaveLength(0);
  });

  it("draws a new key if the server says the id is taken", async () => {
    const server = fakeServer();
    const ids: string[] = [];
    let collisions = 1;
    const colliding: Transport = async (path, init) => {
      if (path === "/api/tickets") {
        ids.push(JSON.parse(String(init.body)).id);
        if (collisions-- > 0) return new Response(JSON.stringify({ error: "exists" }), { status: 409 });
      }
      return server.transport(path, init);
    };
    const issued = await issueTicket(text, 3600, colliding, "https://x.test");
    expect(issued.kind).toBe("issued");
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);

    const reading = parseTicketFragment(new URL((issued as { link: string }).link).hash);
    if (reading.kind !== "ticket") throw new Error(reading.kind);
    expect(await revealTicket(reading.capability, server.transport)).toEqual({ kind: "opened", plaintext: text });
  });

  it("gives up after repeated collisions instead of looping", async () => {
    let creates = 0;
    const alwaysTaken: Transport = async () => {
      creates++;
      return new Response(JSON.stringify({ error: "exists" }), { status: 409 });
    };
    expect(await issueTicket(text, 3600, alwaysTaken, "x")).toEqual({ kind: "failed", reason: "server" });
    expect(creates).toBe(3);
  });

  it("refuses empty and oversized text before touching the network", async () => {
    const server = fakeServer();
    expect(await issueTicket("  \n", 3600, server.transport, "x")).toEqual({ kind: "failed", reason: "empty" });
    expect(await issueTicket("A=" + "x".repeat(MAX_PLAINTEXT_BYTES), 3600, server.transport, "x")).toEqual({
      kind: "failed",
      reason: "too_large",
    });
    expect(server.sent).toHaveLength(0);
  });
});
