// R3: seal an env file into a new stub and return its link, optionally locked to a recipient (R10).

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parsePublicId } from "../../src/core/lock";
import { issueTicket, type IssueOutcome, type Transport } from "../../src/core/ticket";
import { DEFAULT_TTL_SECONDS, isTtlSeconds, type TtlSeconds } from "../../src/shared/protocol";
import { DEFAULT_ENV_FILE } from "./pull";
import { errorCode, fail, type Failure } from "./result";

const TTL_UNITS: Record<string, number> = { m: 60, h: 60 * 60, d: 24 * 60 * 60 };

/** "5m", "1h", "1d", "7d": the same choices the web page offers. */
export function parseTtl(text: string): TtlSeconds | null {
  const match = /^(\d+)([mhd])$/.exec(text);
  if (!match) return null;
  const seconds = Number(match[1]) * (TTL_UNITS[match[2]!] ?? 0);
  return isTtlSeconds(seconds) ? seconds : null;
}

export interface PushOptions {
  origin: string;
  /** A path, "-" for stdin, or undefined for .env.local. */
  file?: string;
  ttl?: string;
  /** A recipient's public id; the link then only opens with their identity. */
  lockTo?: string;
}

export interface PushDeps {
  transport: Transport;
  cwd: string;
  readStdin: () => Promise<string>;
}

export type PushSuccess = { ok: true; link: string; expiresAt: number; locked?: true };

export async function pushStub(options: PushOptions, deps: PushDeps): Promise<PushSuccess | Failure> {
  const ttl = options.ttl === undefined ? DEFAULT_TTL_SECONDS : parseTtl(options.ttl);
  if (ttl === null) return fail("invalid", "--ttl must be one of 5m, 1h, 1d, 7d.");
  const lockTo = options.lockTo?.trim();
  if (lockTo !== undefined && !parsePublicId(lockTo)) {
    return fail("invalid", "That isn't a stubs id. Nothing was sent.");
  }

  const file = options.file ?? DEFAULT_ENV_FILE;
  const source = file === "-" ? "stdin" : file;
  let text: string;
  try {
    text = file === "-" ? await deps.readStdin() : await readFile(resolve(deps.cwd, file), "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return fail("invalid", `${source} doesn't exist.`);
    if (code === "EISDIR") return fail("invalid", `${source} is a folder, not a file.`);
    return fail("error", `Couldn't read ${source} (${code}).`);
  }

  let outcome: IssueOutcome;
  try {
    outcome = await issueTicket(text, ttl, deps.transport, options.origin, lockTo ? { lockTo } : {});
  } catch {
    return fail("error", "Couldn't seal the stub.");
  }
  if (outcome.kind === "issued") {
    const sealed: PushSuccess = { ok: true, link: outcome.link, expiresAt: outcome.expiresAt };
    return lockTo ? { ...sealed, locked: true } : sealed;
  }
  switch (outcome.reason) {
    case "empty":
      return fail("invalid", `${source} is empty; there's nothing to send.`);
    case "bad_recipient":
      return fail(
        "invalid",
        "That stubs id can't receive a locked stub. Ask the recipient to run `stubs id` again. Nothing was sent.",
      );
    case "too_large":
      return fail("invalid", `${source} is larger than the 32 KB a stub can hold.`);
    case "network":
      return fail("network", `Couldn't reach ${new URL(options.origin).host}. No stub was created.`);
    case "rate_limited":
      return fail("network", "The server is rate limiting requests. No stub was created; try again in a minute.");
    case "server":
      return fail("error", "The server couldn't create the stub.");
  }
}

