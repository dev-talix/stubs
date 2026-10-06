// R2: report whether a stub is still sealed. Never consumes it.

import { inspectTicket, type Transport } from "../../src/core/ticket";
import type { IdentityDeps } from "./identity";
import { openLink } from "./links";
import { fail, isFailure, type Failure } from "./result";

export type CheckSuccess = { ok: true; status: "sealed"; expiresAt: number } | { ok: true; status: "void" };

export async function checkStub(
  options: { link: string; origin: string },
  deps: { transport: Transport; identity: IdentityDeps },
): Promise<CheckSuccess | Failure> {
  const link = await openLink(options.link, options.origin, deps.identity);
  if (isFailure(link)) return link;

  const outcome = await inspectTicket(link.capability, deps.transport).catch(() => null);
  switch (outcome?.kind) {
    case "sealed":
      return { ok: true, status: "sealed", expiresAt: outcome.expiresAt };
    case "void":
      return { ok: true, status: "void" };
    case "failed":
      if (outcome.reason === "network") return fail("network", `Couldn't reach ${new URL(link.origin).host}.`);
      if (outcome.reason === "rate_limited") {
        return fail("network", "The server is rate limiting requests. Try again in a minute.");
      }
      return fail("error", "The server refused the request.");
    default:
      return fail("error", "Couldn't check the stub.");
  }
}
