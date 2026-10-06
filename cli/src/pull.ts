// R1: open a stub and merge it into an env file. Every check that can run before the claim
// does, because the claim destroys the server copy: after it, this process holds the only one,
// so nothing after the claim refuses. Existing keys are skipped rather than treated as errors.

import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { revealTicket, type RevealOutcome, type Transport } from "../../src/core/ticket";
import { isNotFound, mergeEnv, writeFileAtomic, writeRecoveryFile } from "./env-file";
import { decideGuard, guardMessage, probeGit, type GitFacts } from "./git-guard";
import { recoveryDir, type IdentityDeps } from "./identity";
import { openLink } from "./links";
import { errorCode, fail, isFailure, type Failure } from "./result";

export const DEFAULT_ENV_FILE = ".env.local";

export interface PullOptions {
  link: string;
  /** Allowed origin for the link. */
  origin: string;
  to?: string;
  overwrite?: boolean;
  allowTracked?: boolean;
}

export interface PullDeps {
  transport: Transport;
  cwd: string;
  /** Where this machine's identity (locked links) and recovery files live. */
  identity: IdentityDeps;
  probeGit?: (file: string) => Promise<GitFacts>;
  now?: () => Date;
}

export interface PullSuccess {
  ok: true;
  file: string;
  written: string[];
  skipped: string[];
  unparsed: number;
  warnings: string[];
}

const NOTHING_CONSUMED = "Nothing was consumed.";

export async function pullStub(options: PullOptions, deps: PullDeps): Promise<PullSuccess | Failure> {
  const link = await openLink(options.link, options.origin, deps.identity);
  if (isFailure(link)) return link;

  const file = options.to ?? DEFAULT_ENV_FILE;
  const target = await resolveTarget(resolve(deps.cwd, file), file);
  if (isFailure(target)) return target;

  if (!options.allowTracked) {
    const decision = decideGuard(await (deps.probeGit ?? probeGit)(target), false);
    if (decision.kind === "refuse") return fail("refused", guardMessage(decision.reason, file));
  }

  let revealed: RevealOutcome;
  try {
    revealed = await revealTicket(link.capability, deps.transport);
  } catch {
    return fail("error", `Couldn't open the stub. ${NOTHING_CONSUMED}`);
  }
  if (revealed.kind !== "opened") return revealFailure(revealed);

  // From here on the stub is void on the server, so every exit must account for the values.
  let plan;
  try {
    plan = mergeEnv(await readExisting(target), revealed.plaintext, options.overwrite ?? false);
    if (plan.content) await writeFileAtomic(target, plan.content);
  } catch (error) {
    return recover(revealed.plaintext, target, file, deps, errorCode(error));
  }
  const warnings = plan.content
    ? plan.malformedLines.map(
        (line) => `Line ${line} of ${file} is malformed; a dotenv parser may not read the keys appended after it.`,
      )
    : [];
  return { ok: true, file, written: plan.written, skipped: plan.skipped, unparsed: plan.unparsed, warnings };
}

/**
 * Resolves symlinks so the git guard and the write see the file that will really change: the
 * target itself when it exists, else its folder. Everything that can fail is checked here,
 * before the claim.
 */
async function resolveTarget(path: string, file: string): Promise<string | Failure> {
  try {
    const existing = await stat(path);
    if (!existing.isFile()) return fail("invalid", `${file} isn't a regular file. ${NOTHING_CONSUMED}`);
    const real = await realpath(path);
    await access(real, constants.R_OK);
    await access(dirname(real), constants.W_OK);
    return real;
  } catch (error) {
    if (!isNotFound(error)) {
      return fail("error", `Can't read or replace ${file} (${errorCode(error)}). ${NOTHING_CONSUMED}`);
    }
  }

  try {
    const dir = await realpath(dirname(path));
    if (!(await stat(dir)).isDirectory()) throw Object.assign(new Error(), { code: "ENOTDIR" });
    await access(dir, constants.W_OK);
    return join(dir, basename(path));
  } catch (error) {
    if (isNotFound(error)) return fail("invalid", `The folder for ${file} doesn't exist. ${NOTHING_CONSUMED}`);
    return fail("error", `Can't create ${file} (${errorCode(error)}). ${NOTHING_CONSUMED}`);
  }
}

async function readExisting(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function revealFailure(outcome: Exclude<RevealOutcome, { kind: "opened" }>): Failure {
  switch (outcome.kind) {
    case "void":
      return fail("void", "The stub is void: it was already opened or has expired. Ask the sender for a new one.");
    case "tampered":
      return fail(
        "tampered",
        "The stub was opened, but its contents don't match the link, so nothing was written. It is now void; ask the sender for a new one.",
      );
    case "uncertain":
      return fail(
        "uncertain",
        "The connection dropped while opening the stub, so it may or may not have been opened. Run the same command again: it either pulls the values or reports the stub as void.",
      );
    case "failed":
      return outcome.reason === "rate_limited"
        ? fail("network", `The server is rate limiting requests. ${NOTHING_CONSUMED} Try again in a minute.`)
        : fail("error", `The server refused the request. ${NOTHING_CONSUMED}`);
  }
}

/** The write failed after the claim. Save the plaintext under the config dir rather than lose it. */
async function recover(plaintext: string, target: string, file: string, deps: PullDeps, code: string): Promise<Failure> {
  try {
    const saved = await writeRecoveryFile(recoveryDir(deps.identity), basename(target), plaintext, deps.now?.());
    return fail(
      "error",
      `Couldn't write ${file} (${code}). The stub is now void, so its contents were saved to ${saved} (mode 0600). Move the values into place, then delete that file.`,
      { recoveredFile: saved },
    );
  } catch (error) {
    return fail(
      "error",
      `Couldn't write ${file} (${code}) or a recovery file (${errorCode(error)}). The stub is now void and its values are lost; ask the sender for a new one.`,
    );
  }
}
