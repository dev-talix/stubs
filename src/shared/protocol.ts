// Wire contract between the browser and the Worker: routes, payload shapes, runtime validation,
// and error codes. Both sides validate with the same functions, so neither trusts the other.
//
// The server only ever sees an opaque id, a hash of the claim secret, AES-GCM ciphertext, and
// its IV. The ticket key that derives all of them lives in the URL fragment, which browsers
// never send to a server.

/** Byte sizes fixed by ticket format v1. Changing any of them means a new format version. */
export const TICKET_FORMAT = {
  version: 1,
  keyBytes: 32,
  idBytes: 16,
  claimSecretBytes: 32,
  claimHashBytes: 32,
  ivBytes: 12,
  tagBytes: 16,
} as const;

/** Length of unpadded base64url text for `bytes` bytes. */
export function base64UrlLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

/** Largest .env payload the client will encrypt, in UTF-8 bytes. */
export const MAX_PLAINTEXT_BYTES = 32 * 1024;

/** Ciphertext carries the GCM tag, so even one plaintext byte is tag + 1. */
export const MIN_CIPHERTEXT_CHARS = base64UrlLength(1 + TICKET_FORMAT.tagBytes);
export const MAX_CIPHERTEXT_CHARS = base64UrlLength(MAX_PLAINTEXT_BYTES + TICKET_FORMAT.tagBytes);

/** Upper bound on any request body the API reads. */
export const MAX_REQUEST_BYTES = 64 * 1024;

export const TTL_SECONDS = [5 * 60, 60 * 60, 24 * 60 * 60, 7 * 24 * 60 * 60] as const;
export type TtlSeconds = (typeof TTL_SECONDS)[number];
export const DEFAULT_TTL_SECONDS: TtlSeconds = 60 * 60;
export const MAX_TTL_SECONDS: TtlSeconds = TTL_SECONDS[TTL_SECONDS.length - 1]!;

// ---------- Routes ----------
//
// Every route is a JSON POST. Status and claim take the claim secret in the body, so an id
// (which appears in request logs) can't check, read, or burn a ticket. Create refuses ids in
// use until their expiry, which keeps links unique and reveals only that an id is taken.

export const ROUTES = {
  create: "/api/tickets",
  status: (id: string) => `/api/tickets/${id}/status`,
  claim: (id: string) => `/api/tickets/${id}/claim`,
} as const;

/** Matches status and claim paths; group 1 is the id, group 2 the action. */
export const TICKET_ROUTE_PATTERN = /^\/api\/tickets\/([^/]+)\/(status|claim)$/;

// ---------- Payloads ----------

/** POST /api/tickets */
export interface CreateTicketRequest {
  id: string;
  /** SHA-256 of the claim secret. The secret itself is only ever sent to status and claim. */
  claimHash: string;
  ciphertext: string;
  iv: string;
  ttlSeconds: TtlSeconds;
}

/** 201 from create. */
export interface CreateTicketResponse {
  expiresAt: number; // epoch milliseconds
}

/** Body of status and claim: proof the caller holds the ticket key. */
export interface TicketProof {
  claimSecret: string;
}

/** 200 from status. Never consumes the ticket. */
export interface TicketStatus {
  expiresAt: number;
}

/** 200 from claim. The ticket is deleted before this response is sent. */
export interface SealedTicket {
  ciphertext: string;
  iv: string;
}

export const API_ERRORS = {
  invalid_request: 400,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  exists: 409,
  too_large: 413,
  rate_limited: 429,
  internal: 500,
} as const;

export type ApiErrorCode = keyof typeof API_ERRORS;

export interface ApiError {
  error: ApiErrorCode;
}

// ---------- Validation ----------

const base64UrlOf = (bytes: number) => new RegExp(`^[A-Za-z0-9_-]{${base64UrlLength(bytes)}}$`);

export const PATTERNS = {
  ticketKey: base64UrlOf(TICKET_FORMAT.keyBytes),
  id: base64UrlOf(TICKET_FORMAT.idBytes),
  claimSecret: base64UrlOf(TICKET_FORMAT.claimSecretBytes),
  claimHash: base64UrlOf(TICKET_FORMAT.claimHashBytes),
  iv: base64UrlOf(TICKET_FORMAT.ivBytes),
  base64Url: /^[A-Za-z0-9_-]+$/,
} as const;

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function isTtlSeconds(value: unknown): value is TtlSeconds {
  return TTL_SECONDS.some((ttl) => ttl === value);
}

export function isCiphertext(value: unknown): value is string {
  return (
    matches(value, PATTERNS.base64Url) &&
    value.length >= MIN_CIPHERTEXT_CHARS &&
    value.length <= MAX_CIPHERTEXT_CHARS
  );
}

export function parseCreateTicketRequest(value: unknown): CreateTicketRequest | null {
  if (!isObject(value)) return null;
  const { id, claimHash, ciphertext, iv, ttlSeconds } = value;
  if (
    !matches(id, PATTERNS.id) ||
    !matches(claimHash, PATTERNS.claimHash) ||
    !isCiphertext(ciphertext) ||
    !matches(iv, PATTERNS.iv) ||
    !isTtlSeconds(ttlSeconds)
  ) {
    return null;
  }
  return { id, claimHash, ciphertext, iv, ttlSeconds };
}

export function parseTicketProof(value: unknown): TicketProof | null {
  if (!isObject(value) || !matches(value.claimSecret, PATTERNS.claimSecret)) return null;
  return { claimSecret: value.claimSecret };
}

export function parseCreateTicketResponse(value: unknown): CreateTicketResponse | null {
  return isObject(value) && isTimestamp(value.expiresAt) ? { expiresAt: value.expiresAt } : null;
}

export function parseTicketStatus(value: unknown): TicketStatus | null {
  return isObject(value) && isTimestamp(value.expiresAt) ? { expiresAt: value.expiresAt } : null;
}

export function parseSealedTicket(value: unknown): SealedTicket | null {
  if (!isObject(value) || !isCiphertext(value.ciphertext) || !matches(value.iv, PATTERNS.iv)) {
    return null;
  }
  return { ciphertext: value.ciphertext, iv: value.iv };
}

export function parseApiError(value: unknown): ApiErrorCode | null {
  if (!isObject(value) || typeof value.error !== "string") return null;
  return Object.hasOwn(API_ERRORS, value.error) ? (value.error as ApiErrorCode) : null;
}
