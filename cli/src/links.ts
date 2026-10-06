// Reads a Stubs link into an origin and a ticket capability, and decides which origin is trusted.
// Locked (v2) links are unwrapped here with the local identity. Nothing here touches the
// network, and no message repeats the link.

import { unlockTicketKey } from "../../src/core/lock";
import { parseTicketFragment, type TicketCapability } from "../../src/core/ticket";
import { loadIdentity, type IdentityDeps } from "./identity";
import { fail, isFailure, type Failure } from "./result";

export const DEFAULT_ORIGIN = "https://stubs.talix.app";

/** `--origin` beats `STUBS_ORIGIN`, which beats the default. Returns a bare origin. */
export function resolveOrigin(flag: string | undefined, env: string | undefined): string | Failure {
  const raw = flag ?? (env ? env : undefined) ?? DEFAULT_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("invalid", "The origin isn't a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return fail("invalid", "The origin must be an http or https URL.");
  }
  return url.origin;
}

export type LinkReading =
  | { origin: string; capability: TicketCapability }
  /** A v2 link: `locked` is `<ephemeralPub>.<wrapped>`, opened only with the right identity. */
  | { origin: string; locked: string };

/**
 * Characters a real link can contain. Anything else (quotes, `$`, `;`, spaces, `?`, `@`, `%`)
 * means the text isn't a link the site made, and may be an attempt to break out of the quotes
 * an agent wraps it in. Checked on the raw text so percent-encoding can't hide one.
 */
const LINK_CHARACTERS = /^[A-Za-z0-9_.\-:/#]+$/;

export function parseLink(link: string, allowedOrigin: string): LinkReading | Failure {
  const raw = link.trim();
  const host = new URL(allowedOrigin).host;
  // No scheme in the example: the output redactor would swallow anything that looks like a URL.
  const notPlain = fail("invalid", `That isn't a plain Stubs link (${host}/t#…). Nothing was consumed.`);
  if (!LINK_CHARACTERS.test(raw)) return notPlain;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("invalid", "That isn't a Stubs link. Nothing was consumed.");
  }
  if (url.origin !== allowedOrigin) {
    return fail(
      "invalid",
      `The link isn't from ${host}. Pass --origin (or set STUBS_ORIGIN) if you trust it. Nothing was consumed.`,
    );
  }
  // The site redirects /t/ to /t, so both are the same link.
  const plainPath = url.pathname === "/t" || url.pathname === "/t/";
  if (url.search !== "" || url.username !== "" || url.password !== "" || !plainPath) return notPlain;
  const reading = parseTicketFragment(url.hash);
  switch (reading.kind) {
    case "ticket":
      return { origin: url.origin, capability: reading.capability };
    case "locked":
      return { origin: url.origin, locked: reading.locked };
    case "missing":
      return fail("invalid", "The link is missing its key (the part after #). Check it was copied in full.");
    case "unsupported_version":
      return fail("invalid", "The link uses a newer format than this version of stubs. Update @talix/stubs.");
    case "malformed":
      return fail("invalid", "The link's key is damaged. Check it was copied in full.");
  }
}

/** Parses a link and, if it's locked, unwraps it with this machine's identity. */
export async function openLink(
  link: string,
  allowedOrigin: string,
  identity: IdentityDeps,
): Promise<{ origin: string; capability: TicketCapability } | Failure> {
  const reading = parseLink(link, allowedOrigin);
  if (isFailure(reading) || "capability" in reading) return reading;

  const local = await loadIdentity(identity);
  if (isFailure(local)) return local;
  if (!local) {
    return fail(
      "invalid",
      "This stub is locked to a machine, and this machine has no stubs identity. Run the command on the machine whose id the sender used (the one where `stubs init` was run). Nothing was consumed.",
    );
  }
  const key = await unlockTicketKey(reading.locked, local);
  if (!key) {
    return fail(
      "invalid",
      "This stub isn't locked to this machine's identity (or the link was altered). Nothing was consumed.",
    );
  }
  // Re-read as a v1 fragment so the capability comes from the one function allowed to make it.
  const unlocked = parseTicketFragment(`v1.${key}`);
  if (unlocked.kind !== "ticket") return fail("invalid", "The link's key is damaged. Nothing was consumed.");
  return { origin: reading.origin, capability: unlocked.capability };
}
