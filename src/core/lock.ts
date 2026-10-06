// Locking a stub to a recipient. A locked link carries the ticket key wrapped to the recipient's
// X25519 public key, so the link alone can't open the stub: only the machine holding the matching
// private key can unwrap it. Storage and the server are untouched; a locked link just unwraps
// to an ordinary ticket key.
//
// Wrap: ephemeral X25519 pair → shared = X25519(ephemeralPriv, recipientPub)
//       wrapKey = HKDF-SHA256(shared, salt "env-ticket/link-v2", info ephemeralPub || recipientPub)
//       wrapped = iv || AES-GCM(wrapKey, iv, ticketKey, aad "v2")
// The ephemeral private key is discarded, so nothing but the recipient's key can repeat this.

import { fromBase64Url, toBase64Url } from "./crypto";
import { PATTERNS, TICKET_FORMAT } from "../shared/protocol";

// Structural stand-ins: the browser, Workers, and Node type definitions name these differently.
type KeyPair = { publicKey: CryptoKey; privateKey: CryptoKey };
type Jwk = { x?: string };
type DeriveAlgorithm = Parameters<SubtleCrypto["deriveBits"]>[0];

const encoder = new TextEncoder();
const HKDF_SALT = encoder.encode("env-ticket/link-v2");
const AAD = encoder.encode("v2");
const IV_BYTES = 12;
const X25519_BYTES = 32;

/** Link fragments that carry a wrapped key start with `v2.`; bare keys are `v1.`. */
export const LINK_FORMAT_VERSION_LOCKED = 2;

/** Public ids look like `stubs1` + base64url of the 32-byte X25519 public key. */
export const PUBLIC_ID_PREFIX = "stubs1";
export const PUBLIC_ID_PATTERN = /^stubs1[A-Za-z0-9_-]{43}$/;

/** `<ephemeralPub>.<wrapped>`: 43 chars, a dot, then 80 chars (12-byte iv + 48-byte box). */
export const LOCKED_PATTERN = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{80})$/;

export interface Identity {
  /** PKCS#8 X25519 private key, base64url. Never leaves the recipient's machine. */
  secret: string;
  publicId: string;
}

/** Whether this runtime can do X25519 in WebCrypto (current browsers, Node 20+, workerd). */
export async function supportsLocking(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    return true;
  } catch {
    return false;
  }
}

export async function generateIdentity(): Promise<Identity> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as unknown as KeyPair;
  const secret = toBase64Url(await exportBytes("pkcs8", pair.privateKey));
  return { secret, publicId: publicIdOf(await exportBytes("raw", pair.publicKey)) };
}

/** Recovers the public id from a stored secret, or null if the secret isn't a valid key. */
export async function publicIdFromSecret(secret: string): Promise<string | null> {
  try {
    return publicIdOf(await publicBytesOf(await importSecret(secret)));
  } catch {
    return null;
  }
}

/** Wraps a ticket key to a recipient. Returns the v2 fragment body `<ephemeralPub>.<wrapped>`. */
export async function lockTicketKey(ticketKey: string, recipientPublicId: string): Promise<string> {
  const recipientPub = parsePublicId(recipientPublicId);
  if (!recipientPub) throw new Error("Malformed recipient id");
  if (!PATTERNS.ticketKey.test(ticketKey)) throw new Error("Malformed ticket key");

  const ephemeral = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as unknown as KeyPair;
  const ephemeralPub = await exportBytes("raw", ephemeral.publicKey);
  const recipientKey = await importPublic(recipientPub);
  const wrapKey = await deriveWrapKey(ephemeral.privateKey, recipientKey, ephemeralPub, recipientPub);

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const box = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: AAD },
    wrapKey,
    fromBase64Url(ticketKey),
  );
  const wrapped = new Uint8Array(IV_BYTES + box.byteLength);
  wrapped.set(iv);
  wrapped.set(new Uint8Array(box), IV_BYTES);
  return `${toBase64Url(ephemeralPub)}.${toBase64Url(wrapped)}`;
}

/**
 * Unwraps a locked fragment body with the recipient's secret. Null means it isn't locked to
 * this identity (or was altered); nothing distinguishes the two, by design.
 */
export async function unlockTicketKey(locked: string, identity: Pick<Identity, "secret">): Promise<string | null> {
  const match = LOCKED_PATTERN.exec(locked);
  if (!match) return null;
  try {
    const ephemeralPub = fromBase64Url(match[1]!);
    const wrapped = fromBase64Url(match[2]!);
    const privateKey = await importSecret(identity.secret);
    const recipientPub = await publicBytesOf(privateKey);
    const wrapKey = await deriveWrapKey(privateKey, await importPublic(ephemeralPub), ephemeralPub, recipientPub);
    const ticketKey = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: wrapped.slice(0, IV_BYTES), additionalData: AAD },
      wrapKey,
      wrapped.slice(IV_BYTES),
    );
    const text = toBase64Url(new Uint8Array(ticketKey));
    return PATTERNS.ticketKey.test(text) ? text : null;
  } catch {
    return null;
  }
}

export function parsePublicId(id: string): Uint8Array<ArrayBuffer> | null {
  if (!PUBLIC_ID_PATTERN.test(id)) return null;
  const bytes = fromBase64Url(id.slice(PUBLIC_ID_PREFIX.length));
  return bytes.length === X25519_BYTES ? bytes : null;
}

function publicIdOf(publicKey: Uint8Array): string {
  return PUBLIC_ID_PREFIX + toBase64Url(publicKey);
}

async function exportBytes(format: "raw" | "pkcs8", key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array((await crypto.subtle.exportKey(format, key)) as ArrayBuffer);
}

/** The public half of a private X25519 key: WebCrypto exposes it through the JWK `x` field. */
async function publicBytesOf(privateKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as Jwk;
  if (!jwk.x) throw new Error("Private key has no public half");
  return fromBase64Url(jwk.x);
}

function importSecret(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", fromBase64Url(secret), { name: "X25519" }, true, ["deriveBits"]);
}

function importPublic(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "X25519" }, false, []);
}

async function deriveWrapKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  ephemeralPub: Uint8Array,
  recipientPub: Uint8Array,
): Promise<CryptoKey> {
  // `public` is the standard parameter name; the Workers types spell it `$public`.
  const algorithm = { name: "X25519", public: publicKey } as unknown as DeriveAlgorithm;
  const shared = await crypto.subtle.deriveBits(algorithm, privateKey, X25519_BYTES * 8);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const info = new Uint8Array(ephemeralPub.length + recipientPub.length);
  info.set(ephemeralPub);
  info.set(recipientPub, ephemeralPub.length);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info },
    material,
    { name: "AES-GCM", length: TICKET_FORMAT.keyBytes * 8 },
    false,
    ["encrypt", "decrypt"],
  );
}
