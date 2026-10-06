import { describe, expect, it } from "vitest";
import {
  MAX_CIPHERTEXT_CHARS,
  MAX_PLAINTEXT_BYTES,
  MIN_CIPHERTEXT_CHARS,
  ROUTES,
  TICKET_ROUTE_PATTERN,
  base64UrlLength,
  isTtlSeconds,
  parseApiError,
  parseCreateTicketRequest,
  parseSealedTicket,
  parseTicketProof,
  parseTicketStatus,
} from "../../src/shared/protocol";

const valid = {
  id: "a".repeat(22),
  claimHash: "b".repeat(43),
  ciphertext: "c".repeat(MIN_CIPHERTEXT_CHARS),
  iv: "d".repeat(16),
  ttlSeconds: 3600,
};

describe("sizes", () => {
  it("derives base64url lengths from byte counts", () => {
    expect([16, 12, 32].map(base64UrlLength)).toEqual([22, 16, 43]);
    expect(MIN_CIPHERTEXT_CHARS).toBe(23); // 1 byte + 16-byte tag
    expect(MAX_CIPHERTEXT_CHARS).toBe(base64UrlLength(MAX_PLAINTEXT_BYTES + 16));
  });
});

describe("parseCreateTicketRequest", () => {
  it("accepts a valid request and drops unknown fields", () => {
    expect(parseCreateTicketRequest({ ...valid, extra: "x" })).toEqual(valid);
  });

  it.each([
    ["id too short", { id: "a".repeat(21) }],
    ["id bad char", { id: "a".repeat(21) + "=" }],
    ["claimHash missing", { claimHash: undefined }],
    ["ciphertext one short", { ciphertext: "c".repeat(MIN_CIPHERTEXT_CHARS - 1) }],
    ["ciphertext one long", { ciphertext: "c".repeat(MAX_CIPHERTEXT_CHARS + 1) }],
    ["ciphertext not base64url", { ciphertext: "c".repeat(30) + "+" }],
    ["iv wrong length", { iv: "d".repeat(15) }],
    ["ttl not offered", { ttlSeconds: 60 }],
    ["ttl as string", { ttlSeconds: "3600" }],
  ])("rejects %s", (_name, override) => {
    expect(parseCreateTicketRequest({ ...valid, ...override })).toBeNull();
  });

  it("accepts the largest allowed ciphertext", () => {
    expect(parseCreateTicketRequest({ ...valid, ciphertext: "c".repeat(MAX_CIPHERTEXT_CHARS) })).not.toBeNull();
  });

  it.each([null, [], "x", 1])("rejects non-objects: %j", (value) => {
    expect(parseCreateTicketRequest(value)).toBeNull();
  });
});

describe("other parsers", () => {
  it("validates proofs, statuses, sealed tickets, and errors", () => {
    expect(parseTicketProof({ claimSecret: "e".repeat(43) })).toEqual({ claimSecret: "e".repeat(43) });
    expect(parseTicketProof({ claimSecret: "e".repeat(42) })).toBeNull();
    expect(parseTicketStatus({ expiresAt: 1 })).toEqual({ expiresAt: 1 });
    expect(parseTicketStatus({ expiresAt: -1 })).toBeNull();
    expect(parseTicketStatus({ expiresAt: 1.5 })).toBeNull();
    expect(parseSealedTicket({ ciphertext: valid.ciphertext, iv: valid.iv })).not.toBeNull();
    expect(parseSealedTicket({ ciphertext: valid.ciphertext })).toBeNull();
    expect(parseApiError({ error: "rate_limited" })).toBe("rate_limited");
    expect(parseApiError({ error: "toString" })).toBeNull();
    expect(parseApiError({ error: "teapot" })).toBeNull();
    expect(isTtlSeconds(300)).toBe(true);
    expect(isTtlSeconds(301)).toBe(false);
  });

  it("matches only the routes it builds", () => {
    expect(TICKET_ROUTE_PATTERN.exec(ROUTES.status("abc"))?.slice(1)).toEqual(["abc", "status"]);
    expect(TICKET_ROUTE_PATTERN.exec(ROUTES.claim("abc"))?.slice(1)).toEqual(["abc", "claim"]);
    expect(TICKET_ROUTE_PATTERN.test("/api/tickets/abc/delete")).toBe(false);
    expect(TICKET_ROUTE_PATTERN.test(ROUTES.create)).toBe(false);
  });
});
