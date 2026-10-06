import { describe, expect, it } from "vitest";
import { fromBase64Url, generateTicketKey, toBase64Url } from "../../src/core/crypto";
import {
  LOCKED_PATTERN,
  PUBLIC_ID_PATTERN,
  generateIdentity,
  lockTicketKey,
  parsePublicId,
  publicIdFromSecret,
  supportsLocking,
  unlockTicketKey,
} from "../../src/core/lock";

describe("identity", () => {
  it("is supported in this runtime", async () => {
    expect(await supportsLocking()).toBe(true);
  });

  it("generates a public id in the documented shape and recovers it from the secret", async () => {
    const identity = await generateIdentity();
    expect(identity.publicId).toMatch(PUBLIC_ID_PATTERN);
    expect(identity.publicId).toHaveLength(49);
    expect(await publicIdFromSecret(identity.secret)).toBe(identity.publicId);
    expect((await generateIdentity()).publicId).not.toBe(identity.publicId);
  });

  it("rejects ids that aren't the one canonical encoding of a key", async () => {
    const { publicId } = await generateIdentity();
    const raw = parsePublicId(publicId)!;
    // Top bit set: X25519 would treat it as the same key, but the wrap binds the bytes.
    const flipped = new Uint8Array(raw);
    flipped[31]! |= 0x80;
    expect(parsePublicId("stubs1" + toBase64Url(flipped))).toBeNull();
    // Stray bits in the last base64url character decode to the same bytes with different text.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = publicId.at(-1)!;
    const alias = publicId.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1];
    expect(fromBase64Url(alias.slice(6))).toEqual(raw);
    expect(parsePublicId(alias)).toBeNull();
    expect(parsePublicId(publicId)).not.toBeNull();
  });

  it("rejects malformed secrets and ids", async () => {
    expect(await publicIdFromSecret("not-a-key")).toBeNull();
    expect(parsePublicId("stubs1" + "A".repeat(42))).toBeNull();
    expect(parsePublicId("stubs2" + "A".repeat(43))).toBeNull();
    expect(parsePublicId("stubs1" + "A".repeat(43))).toHaveLength(32);
  });
});

describe("lock and unlock", () => {
  it("round-trips a ticket key to the recipient and only the recipient", async () => {
    const recipient = await generateIdentity();
    const stranger = await generateIdentity();
    const ticketKey = generateTicketKey();

    const locked = await lockTicketKey(ticketKey, recipient.publicId);
    expect(locked).toMatch(LOCKED_PATTERN);
    expect(locked).not.toContain(ticketKey.slice(0, 10));

    expect(await unlockTicketKey(locked, recipient)).toBe(ticketKey);
    expect(await unlockTicketKey(locked, stranger)).toBeNull();
  });

  it("uses a fresh ephemeral key every time", async () => {
    const recipient = await generateIdentity();
    const ticketKey = generateTicketKey();
    const a = await lockTicketKey(ticketKey, recipient.publicId);
    const b = await lockTicketKey(ticketKey, recipient.publicId);
    expect(a).not.toBe(b);
    expect(a.split(".")[0]).not.toBe(b.split(".")[0]);
  });

  it("fails closed on any alteration", async () => {
    const recipient = await generateIdentity();
    const locked = await lockTicketKey(generateTicketKey(), recipient.publicId);
    const [ephemeral, wrapped] = locked.split(".") as [string, string];
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);

    expect(await unlockTicketKey(`${flip(ephemeral, 5)}.${wrapped}`, recipient)).toBeNull();
    expect(await unlockTicketKey(`${ephemeral}.${flip(wrapped, 20)}`, recipient)).toBeNull();
    expect(await unlockTicketKey(`${ephemeral}.${flip(wrapped, 79)}`, recipient)).toBeNull();
    expect(await unlockTicketKey(locked.slice(0, -1), recipient)).toBeNull();
    expect(await unlockTicketKey("", recipient)).toBeNull();
  });

  it("refuses to lock to a malformed id or with a malformed key", async () => {
    const recipient = await generateIdentity();
    await expect(lockTicketKey(generateTicketKey(), "stubs1short")).rejects.toThrow(/recipient/);
    await expect(lockTicketKey("short", recipient.publicId)).rejects.toThrow(/ticket key/);
  });
});
