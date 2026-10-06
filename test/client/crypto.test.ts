import { describe, expect, it } from "vitest";
import {
  deriveTicketKeys,
  fromBase64Url,
  generateTicketKey,
  seal,
  toBase64Url,
  unseal,
} from "../../src/client/crypto";
import { PATTERNS } from "../../src/shared/protocol";

const ENV = 'DATABASE_URL=postgres://u:p@h/db\nNOTE="multi\nline ✓"\n';

describe("ticket crypto", () => {
  it("generates keys in the link format", () => {
    const key = generateTicketKey();
    expect(key).toMatch(PATTERNS.ticketKey);
    expect(fromBase64Url(key)).toHaveLength(32);
  });

  it("never repeats a key and draws every bit evenly", () => {
    const keys = Array.from({ length: 10_000 }, generateTicketKey);
    expect(new Set(keys).size).toBe(keys.length);

    let ones = 0;
    for (const key of keys) {
      for (const byte of fromBase64Url(key)) {
        for (let b = byte; b; b >>= 1) ones += b & 1;
      }
    }
    // 2,560,000 bits; a fair source lands within a fraction of a percent of half.
    expect(ones / (keys.length * 256)).toBeCloseTo(0.5, 2);
  });

  it("derives stable values that match the wire contract", async () => {
    const key = generateTicketKey();
    const a = await deriveTicketKeys(key);
    const b = await deriveTicketKeys(key);
    expect(a.id).toMatch(PATTERNS.id);
    expect(a.claimSecret).toMatch(PATTERNS.claimSecret);
    expect(a.claimHash).toMatch(PATTERNS.claimHash);
    expect([a.id, a.claimSecret, a.claimHash]).toEqual([b.id, b.claimSecret, b.claimHash]);
    expect((await deriveTicketKeys(generateTicketKey())).id).not.toBe(a.id);
  });

  it("makes the claim hash the SHA-256 of the claim secret", async () => {
    const keys = await deriveTicketKeys(generateTicketKey());
    const digest = await crypto.subtle.digest("SHA-256", fromBase64Url(keys.claimSecret));
    expect(toBase64Url(new Uint8Array(digest))).toBe(keys.claimHash);
  });

  it("derives values that don't reveal the key or each other", async () => {
    const key = generateTicketKey();
    const keys = await deriveTicketKeys(key);
    const derived = [keys.id, keys.claimSecret, keys.claimHash];
    for (const value of derived) expect(key).not.toContain(value.slice(0, 8));
    expect(new Set(derived.map((v) => v.slice(0, 16))).size).toBe(3);
  });

  it("round-trips plaintext through seal and unseal", async () => {
    const keys = await deriveTicketKeys(generateTicketKey());
    const sealed = await seal(ENV, keys);
    expect(sealed.iv).toMatch(PATTERNS.iv);
    expect(sealed.ciphertext).not.toContain("postgres");
    expect(await unseal(sealed, keys)).toBe(ENV);
    await expect(unseal(sealed, await deriveTicketKeys(generateTicketKey()))).rejects.toThrow();
  });

  it("rejects ciphertext replayed under a different id", async () => {
    const keys = await deriveTicketKeys(generateTicketKey());
    const sealed = await seal(ENV, keys);
    await expect(unseal(sealed, { ...keys, id: "AAAAAAAAAAAAAAAAAAAAAA" })).rejects.toThrow();
  });

  it("rejects tampered ciphertext", async () => {
    const keys = await deriveTicketKeys(generateTicketKey());
    const sealed = await seal(ENV, keys);
    const bytes = fromBase64Url(sealed.ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await expect(unseal({ ...sealed, ciphertext: toBase64Url(bytes) }, keys)).rejects.toThrow();
  });

  it("base64url round-trips every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const text = toBase64Url(bytes);
    expect(text).toMatch(PATTERNS.base64Url);
    expect(fromBase64Url(text)).toEqual(bytes);
  });
});
