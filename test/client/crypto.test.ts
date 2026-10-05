import { describe, expect, it } from "vitest";
import {
  TICKET_KEY_PATTERN,
  deriveTicket,
  fromBase64Url,
  generateTicketKey,
  open,
  seal,
  toBase64Url,
} from "../../src/client/crypto";
import { IV_PATTERN, SECRET_ID_PATTERN } from "../../src/shared/protocol";

const ENV = 'DATABASE_URL=postgres://u:p@h/db\nNOTE="multi\nline ✓"\n';

describe("ticket crypto", () => {
  it("generates keys in the link format", () => {
    const key = generateTicketKey();
    expect(key).toMatch(TICKET_KEY_PATTERN);
    expect(fromBase64Url(key)).toHaveLength(32);
  });

  it("derives a stable id that matches the API contract", async () => {
    const key = generateTicketKey();
    const a = await deriveTicket(key);
    const b = await deriveTicket(key);
    expect(a.id).toMatch(SECRET_ID_PATTERN);
    expect(a.id).toBe(b.id);
    expect((await deriveTicket(generateTicketKey())).id).not.toBe(a.id);
  });

  it("round-trips plaintext through seal and open", async () => {
    const ticket = await deriveTicket(generateTicketKey());
    const sealed = await seal(ENV, ticket);
    expect(sealed.iv).toMatch(IV_PATTERN);
    expect(sealed.ciphertext).not.toContain("postgres");
    expect(await open(sealed, await deriveTicket(generateTicketKey())).catch(() => "rejected")).toBe(
      "rejected",
    );
    expect(await open(sealed, ticket)).toBe(ENV);
  });

  it("rejects ciphertext replayed under a different id", async () => {
    const ticket = await deriveTicket(generateTicketKey());
    const sealed = await seal(ENV, ticket);
    await expect(open(sealed, { ...ticket, id: "AAAAAAAAAAAAAAAAAAAAAA" })).rejects.toThrow();
  });

  it("rejects tampered ciphertext", async () => {
    const ticket = await deriveTicket(generateTicketKey());
    const sealed = await seal(ENV, ticket);
    const bytes = fromBase64Url(sealed.ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await expect(open({ ...sealed, ciphertext: toBase64Url(bytes) }, ticket)).rejects.toThrow();
  });

  it("refuses malformed keys", async () => {
    await expect(deriveTicket("too-short")).rejects.toThrow();
    await expect(deriveTicket(generateTicketKey() + "x")).rejects.toThrow();
  });

  it("base64url round-trips every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const text = toBase64Url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64Url(text)).toEqual(bytes);
  });
});
