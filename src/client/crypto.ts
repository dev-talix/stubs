// Client-side encryption. One random 256-bit key is the whole capability: it
// travels in the URL fragment, and both the storage id and the AES-GCM key are
// derived from it with HKDF. The server only ever sees the id and ciphertext.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const HKDF_SALT = encoder.encode("snapkey/v1");
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** A ticket key as it appears after the # in a link. */
export const TICKET_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface Ticket {
  id: string;
  aesKey: CryptoKey;
}

export interface Sealed {
  ciphertext: string;
  iv: string;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function generateTicketKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

export async function deriveTicket(ticketKey: string): Promise<Ticket> {
  if (!TICKET_KEY_PATTERN.test(ticketKey)) throw new Error("Malformed ticket key");
  const base = await crypto.subtle.importKey("raw", fromBase64Url(ticketKey), "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);
  const params = (info: string): HkdfParams => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: HKDF_SALT,
    info: encoder.encode(info),
  });
  const idBits = await crypto.subtle.deriveBits(params("id"), base, 128);
  const aesKey = await crypto.subtle.deriveKey(
    params("enc"),
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { id: toBase64Url(new Uint8Array(idBits)), aesKey };
}

// The id is bound in as associated data so ciphertext can't be replayed under
// a different id.
export async function seal(plaintext: string, ticket: Ticket): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(ticket.id) },
    ticket.aesKey,
    encoder.encode(plaintext),
  );
  return { ciphertext: toBase64Url(new Uint8Array(ciphertext)), iv: toBase64Url(iv) };
}

export async function open(sealed: Sealed, ticket: Ticket): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(sealed.iv), additionalData: encoder.encode(ticket.id) },
    ticket.aesKey,
    fromBase64Url(sealed.ciphertext),
  );
  return decoder.decode(plaintext);
}
