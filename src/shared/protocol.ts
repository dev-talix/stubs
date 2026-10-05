// Wire contract between the browser client and the Worker API.
//
// The server only ever sees an opaque id, AES-GCM ciphertext, and its IV. The
// key that decrypts it (and derives the id) lives in the URL fragment, which
// browsers never send to the server.

export const TTL_OPTIONS = [
  { seconds: 5 * 60, label: "5 min" },
  { seconds: 60 * 60, label: "1 hour" },
  { seconds: 24 * 60 * 60, label: "1 day" },
  { seconds: 7 * 24 * 60 * 60, label: "7 days" },
] as const;

export const DEFAULT_TTL_SECONDS = 60 * 60;

/** Largest .env payload the client will encrypt, in UTF-8 bytes. */
export const MAX_PLAINTEXT_BYTES = 32 * 1024;

/** Base64url length of MAX_PLAINTEXT_BYTES plus the 16-byte GCM tag, rounded up. */
export const MAX_CIPHERTEXT_CHARS = Math.ceil(((MAX_PLAINTEXT_BYTES + 16) * 4) / 3);

/** Upper bound on any request body the API accepts. */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** 16 random-looking bytes, base64url without padding. */
export const SECRET_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** 12-byte AES-GCM IV, base64url without padding. */
export const IV_PATTERN = /^[A-Za-z0-9_-]{16}$/;

export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

// POST /api/secrets
export interface CreateSecretRequest {
  id: string;
  ciphertext: string;
  iv: string;
  ttlSeconds: number;
}
export interface CreateSecretResponse {
  expiresAt: number; // epoch milliseconds
}

// GET /api/secrets/:id  (does not consume)
export interface SecretStatusResponse {
  expiresAt: number;
}

// POST /api/secrets/:id/claim  (consumes: deleted before the response is sent)
export interface ClaimSecretResponse {
  ciphertext: string;
  iv: string;
}

export interface ApiErrorResponse {
  error: string;
}
