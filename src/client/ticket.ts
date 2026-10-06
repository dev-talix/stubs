// The Ticket module: issues, inspects, and reveals one-time tickets. Callers deal only in links,
// opaque capabilities, and outcomes. Key material, derivation, sealing, the claim proof, and the
// order those happen in stay in here, so the privacy rules have exactly one owner:
//
// - the ticket key never leaves this module except inside the link fragment it returns;
// - nothing sent to the server can recover the key (only the derived id, claim hash or claim
//   secret, ciphertext, and IV ever go out);
// - a ticket is consumed only by revealTicket, and only after the server checks the proof.

import { createTicketApi, type Transport } from "./api";
import { deriveTicketKeys, generateTicketKey, seal, unseal } from "./crypto";
import {
  MAX_PLAINTEXT_BYTES,
  PATTERNS,
  TICKET_FORMAT,
  type TtlSeconds,
} from "../shared/protocol";

export type { Transport } from "./api";

declare const capabilityBrand: unique symbol;
/** A validated ticket key. Only parseTicketFragment can make one. */
export type TicketCapability = string & { readonly [capabilityBrand]: true };

/** Everything after the # in a ticket link: `v1.<43-char key>`. */
const FRAGMENT_PATTERN = /^v(\d+)\.(.*)$/;

export type FragmentReading =
  | { kind: "ticket"; capability: TicketCapability }
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "unsupported_version" };

export function parseTicketFragment(fragment: string): FragmentReading {
  const text = fragment.replace(/^#/, "");
  if (text === "") return { kind: "missing" };
  const match = FRAGMENT_PATTERN.exec(text);
  if (!match) return { kind: "malformed" };
  if (Number(match[1]) !== TICKET_FORMAT.version) return { kind: "unsupported_version" };
  const key = match[2] ?? "";
  if (!PATTERNS.ticketKey.test(key)) return { kind: "malformed" };
  return { kind: "ticket", capability: key as TicketCapability };
}

export function ticketLink(origin: string, capability: TicketCapability): string {
  return `${origin}/t#v${TICKET_FORMAT.version}.${capability}`;
}

const ISSUE_ATTEMPTS = 3;

export type IssueOutcome =
  | { kind: "issued"; link: string; expiresAt: number }
  | { kind: "failed"; reason: "empty" | "too_large" | "rate_limited" | "network" | "server" };

export async function issueTicket(
  plaintext: string,
  ttlSeconds: TtlSeconds,
  transport: Transport,
  origin: string,
): Promise<IssueOutcome> {
  if (plaintext.trim() === "") return { kind: "failed", reason: "empty" };
  if (new TextEncoder().encode(plaintext).length > MAX_PLAINTEXT_BYTES) {
    return { kind: "failed", reason: "too_large" };
  }

  const api = createTicketApi(transport);
  // Every attempt uses a fresh 256-bit key from the browser's CSPRNG, so links are unguessable.
  // The server refuses ids already in use, so a link is also guaranteed unique: if a collision
  // ever happened (odds around 2^-128), we'd just draw a new key.
  for (let attempt = 0; attempt < ISSUE_ATTEMPTS; attempt++) {
    const capability = generateTicketKey() as TicketCapability;
    let keys;
    let sealed;
    try {
      keys = await deriveTicketKeys(capability);
      sealed = await seal(plaintext, keys);
    } catch {
      return { kind: "failed", reason: "server" };
    }

    const created = await api.create({ id: keys.id, claimHash: keys.claimHash, ...sealed, ttlSeconds });
    if (created.ok) {
      return { kind: "issued", link: ticketLink(origin, capability), expiresAt: created.value.expiresAt };
    }
    if (created.failure !== "exists") return { kind: "failed", reason: created.failure };
  }
  return { kind: "failed", reason: "server" };
}

export type InspectOutcome =
  | { kind: "sealed"; expiresAt: number }
  | { kind: "void" }
  /** This browser can't run the key derivation the ticket needs. */
  | { kind: "unsupported_browser" }
  | { kind: "failed"; reason: "rate_limited" | "network" | "server" };

/** Checks a ticket without consuming it. */
export async function inspectTicket(
  capability: TicketCapability,
  transport: Transport,
): Promise<InspectOutcome> {
  let keys;
  try {
    keys = await deriveTicketKeys(capability);
  } catch {
    return { kind: "unsupported_browser" };
  }
  const status = await createTicketApi(transport).status(keys.id, {
    claimSecret: keys.claimSecret,
  });
  if (status.ok) return { kind: "sealed", expiresAt: status.value.expiresAt };
  if (status.failure === "not_found") return { kind: "void" };
  return { kind: "failed", reason: status.failure };
}

export type RevealOutcome =
  | { kind: "opened"; plaintext: string }
  | { kind: "void" }
  /** Consumed, but the contents don't match this link. */
  | { kind: "tampered" }
  /** Not consumed; safe to retry. */
  | { kind: "failed"; reason: "rate_limited" | "server" }
  /** May or may not have been consumed; retrying tells which. */
  | { kind: "uncertain" };

/** Consumes the ticket. On "opened" the server copy is already gone. */
export async function revealTicket(
  capability: TicketCapability,
  transport: Transport,
): Promise<RevealOutcome> {
  const keys = await deriveTicketKeys(capability);
  const claim = await createTicketApi(transport).claim(keys.id, {
    claimSecret: keys.claimSecret,
  });
  if (!claim.ok) {
    if (claim.failure === "not_found") return { kind: "void" };
    if (claim.failure === "uncertain") return { kind: "uncertain" };
    return { kind: "failed", reason: claim.failure };
  }
  try {
    return { kind: "opened", plaintext: await unseal(claim.value, keys) };
  } catch {
    return { kind: "tampered" };
  }
}
