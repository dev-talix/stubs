// End to end: the real client Ticket module (real WebCrypto) against the real Worker and
// Durable Object, with a transport spy on every request. This is the guarantee the app makes,
// tested through the interface users actually exercise.

import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectTicket,
  issueTicket,
  parseTicketFragment,
  revealTicket,
  type TicketCapability,
  type Transport,
} from "../../src/core/ticket";
import { generateIdentity, unlockTicketKey } from "../../src/core/lock";
import { MAX_PLAINTEXT_BYTES } from "../../src/shared/protocol";

const ORIGIN = "https://stubs.test";
const worker = (exports as { default: Fetcher }).default;

afterEach(async () => {
  await reset();
});

function spyTransport() {
  const sent: string[] = [];
  const transport: Transport = async (path, init) => {
    const headers = new Headers(init.headers);
    sent.push(path, String(init.body ?? ""), JSON.stringify([...headers]));
    // Its own rate-limit bucket, so other test files can't push this one into 429s.
    headers.set("CF-Connecting-IP", "203.0.113.77");
    return worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }));
  };
  return { transport, sent };
}

async function issue(text: string, transport: Transport) {
  const issued = await issueTicket(text, 3600, transport, ORIGIN);
  if (issued.kind !== "issued") throw new Error(`issue failed: ${issued.reason}`);
  const reading = parseTicketFragment(new URL(issued.link).hash);
  if (reading.kind !== "ticket") throw new Error(`bad link: ${reading.kind}`);
  return { link: issued.link, capability: reading.capability };
}

describe("ticket end to end", () => {
  const env = 'DATABASE_URL=postgres://app:s3cret@db/app\nPRIVATE_KEY="-----BEGIN\\nabc\\n-----END"';

  it("opens exactly once with the real crypto and the real Worker", async () => {
    const { transport } = spyTransport();
    const { capability } = await issue(env, transport);

    expect((await inspectTicket(capability, transport)).kind).toBe("sealed");
    expect((await inspectTicket(capability, transport)).kind).toBe("sealed");
    expect(await revealTicket(capability, transport)).toEqual({ kind: "opened", plaintext: env });
    expect(await revealTicket(capability, transport)).toEqual({ kind: "void" });
    expect(await inspectTicket(capability, transport)).toEqual({ kind: "void" });
  });

  it("never puts the key, the link, or the plaintext on the wire", async () => {
    const { transport, sent } = spyTransport();
    const { link, capability } = await issue(env, transport);
    await inspectTicket(capability, transport);
    await revealTicket(capability, transport);

    const wire = sent.join("\n");
    expect(wire).not.toContain(capability);
    expect(wire).not.toContain(link);
    expect(wire).not.toContain("s3cret");
    expect(wire).not.toContain("BEGIN");
  });

  it("can't be inspected, claimed, or burned with another key", async () => {
    const { transport } = spyTransport();
    const { capability } = await issue(env, transport);
    const stranger = "x".repeat(43) as TicketCapability;

    expect(await inspectTicket(stranger, transport)).toEqual({ kind: "void" });
    expect(await revealTicket(stranger, transport)).toEqual({ kind: "void" });
    expect((await revealTicket(capability, transport)).kind).toBe("opened");
  });

  it("lets only one of many simultaneous reveals open it", async () => {
    const { transport } = spyTransport();
    const { capability } = await issue(env, transport);
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => revealTicket(capability, transport)),
    );
    expect(outcomes.filter((o) => o.kind === "opened")).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "void")).toHaveLength(19);
  });

  it("opens a locked stub only for the recipient, through the real Worker", async () => {
    const { transport, sent } = spyTransport();
    const recipient = await generateIdentity();
    const stranger = await generateIdentity();
    const issued = await issueTicket(env, 3600, transport, ORIGIN, { lockTo: recipient.publicId });
    if (issued.kind !== "issued") throw new Error(issued.reason);

    const reading = parseTicketFragment(new URL(issued.link).hash);
    if (reading.kind !== "locked") throw new Error(reading.kind);
    expect(await unlockTicketKey(reading.locked, stranger)).toBeNull();
    const key = await unlockTicketKey(reading.locked, recipient);
    if (!key) throw new Error("recipient could not unlock");

    expect((await inspectTicket(key as TicketCapability, transport)).kind).toBe("sealed");
    expect(await revealTicket(key as TicketCapability, transport)).toEqual({ kind: "opened", plaintext: env });
    expect(await revealTicket(key as TicketCapability, transport)).toEqual({ kind: "void" });
    // Neither the unwrapped key nor the recipient's secret ever went over the wire.
    const wire = sent.join("\n");
    expect(wire).not.toContain(key);
    expect(wire).not.toContain(recipient.secret);
  });

  it("gives every ticket its own link", async () => {
    const { transport } = spyTransport();
    const links = [];
    for (let i = 0; i < 25; i++) links.push((await issue("A=1", transport)).link);
    expect(new Set(links).size).toBe(links.length);
  });

  it("accepts the largest payload the client allows", async () => {
    const { transport } = spyTransport();
    // Multi-byte characters so the byte limit, not the character count, is what's tested.
    const big = "K=" + "é".repeat((MAX_PLAINTEXT_BYTES - 2) / 2);
    const { capability } = await issue(big, transport);
    expect(await revealTicket(capability, transport)).toEqual({ kind: "opened", plaintext: big });
  });
});
