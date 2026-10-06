// Cryptography for ticket format v1. Only the Ticket module (ticket.ts) calls this.
//
// One random 256-bit ticket key is the whole capability. HKDF derives everything else from it:
// the storage id, the AES-GCM key, and a claim secret that proves possession to the server.
// The server stores only a hash of the claim secret, so an id alone can't open or burn a ticket.

import { TICKET_FORMAT } from "../shared/protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

// Brand-neutral on purpose: renaming the product must never change derived keys.
const HKDF_SALT = encoder.encode(`env-ticket/v${TICKET_FORMAT.version}`);

export interface TicketKeys {
  id: string;
  claimSecret: string;
  claimHash: string;
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
  return toBase64Url(crypto.getRandomValues(new Uint8Array(TICKET_FORMAT.keyBytes)));
}

/** Derives every per-ticket value from the key. The key must already be validated. */
export async function deriveTicketKeys(ticketKey: string): Promise<TicketKeys> {
  const base = await crypto.subtle.importKey("raw", fromBase64Url(ticketKey), "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);
  const params = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: HKDF_SALT,
    info: encoder.encode(info),
  });

  const [idBits, claimBits, aesKey] = await Promise.all([
    crypto.subtle.deriveBits(params("id"), base, TICKET_FORMAT.idBytes * 8),
    crypto.subtle.deriveBits(params("claim"), base, TICKET_FORMAT.claimSecretBytes * 8),
    crypto.subtle.deriveKey(params("enc"), base, { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
  ]);
  const claimHash = await crypto.subtle.digest("SHA-256", claimBits);

  return {
    id: toBase64Url(new Uint8Array(idBits)),
    claimSecret: toBase64Url(new Uint8Array(claimBits)),
    claimHash: toBase64Url(new Uint8Array(claimHash)),
    aesKey,
  };
}

// The id is bound in as associated data, so ciphertext can't be replayed under another id.
export async function seal(plaintext: string, keys: TicketKeys): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(TICKET_FORMAT.ivBytes));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(keys.id) },
    keys.aesKey,
    encoder.encode(plaintext),
  );
  return { ciphertext: toBase64Url(new Uint8Array(ciphertext)), iv: toBase64Url(iv) };
}

/** Rejects if the ciphertext was altered, belongs to another id, or isn't valid UTF-8. */
export async function unseal(sealed: Sealed, keys: TicketKeys): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(sealed.iv), additionalData: encoder.encode(keys.id) },
    keys.aesKey,
    fromBase64Url(sealed.ciphertext),
  );
  return decoder.decode(plaintext);
}
