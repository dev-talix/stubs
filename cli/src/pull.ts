// R1: open a stub and merge it into an env file. Every check that can run before the claim
// does, because the claim destroys the server copy: after it, this process holds the only one,
// so nothing after the claim refuses. Existing keys are skipped rather than treated as errors.

import { access, constants, lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { revealTicket, type RevealOutcome, type Transport } from "../../src/core/ticket";
import { isNotFound, mergeEnv, writeFileAtomic, writeRecoveryFile } from "./env-file";
import { decideGuard, guardMessage, probeGit, type GitFacts } from "./git-guard";
import { recoveryDir, type IdentityDeps } from "./identity";
import { openLink } from "./links";
import { errorCode, fail, isFailure, type Failure } from "./result";

export const DEFAULT_ENV_FILE = ".env.local";

/** Environment names are literal suffixes, never paths or aliases. */
export function envFileFor(name: string): string | Failure {
  if (name === "" || /[^A-Za-z0-9._-]/.test(name)) {
    return fail("invalid", "--env takes a name like production or staging (letters, digits, '.', '_', '-').");
  }
  return `.env.${name}`;
}

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
  /** MCP confines the env target to the real working directory. CLI targets are user-chosen. */
  confineToProject?: boolean;
  probeGit?: (file: string) => Promise<GitFacts>;
  now?: () => Date;
}

export interface PullSuccess {
  ok: true;
  file: string;
  written: string[];
  skipped: string[];
  /** Kept as comments in the file because a dotenv-expand consumer would expand them. */
  held: string[];
  unparsed: number;
  /** Explains a successful pull with no KEY=value lines, without exposing its text. */
  message?: string;
  warnings: string[];
}

const NOTHING_CONSUMED = "Nothing was consumed.";

export async function pullStub(options: PullOptions, deps: PullDeps): Promise<PullSuccess | Failure> {
  const link = await openLink(options.link, options.origin, deps.identity);
  if (isFailure(link)) return link;

  const file = options.to ?? DEFAULT_ENV_FILE;
  let project: string | undefined;
  if (deps.confineToProject) {
    try {
      project = await realpath(deps.cwd);
    } catch (error) {
      return fail("error", `Can't resolve the project directory (${errorCode(error)}). ${NOTHING_CONSUMED}`);
    }
  }
  const target = await resolveTarget(resolve(deps.cwd, file), file, project);
  if (isFailure(target)) return target;

  if (!options.allowTracked) {
    const facts = await (deps.probeGit ?? probeGit)(target);
    const decision = decideGuard(facts, false);
    if (decision.kind === "refuse") {
      // A symlink's destination is what git judged, so that's what the user has to ignore.
      const isLink = await lstat(resolve(deps.cwd, file)).then((entry) => entry.isSymbolicLink(), () => false);
      const shown = !isLink ? undefined : facts.kind === "repo" && facts.root ? relative(facts.root, target) : target;
      return fail("refused", guardMessage(decision.reason, file, shown));
    }
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
  for (const key of plan.held) {
    warnings.push(
      `${key} looks like a $NAME reference. Tools that expand .env values (Vite, Next.js) would replace it with another variable's value, so it was kept as a comment in ${file}. If the $ is literal, uncomment it by hand.`,
    );
  }
  const noPairs = plan.written.length + plan.skipped.length + plan.held.length === 0;
  return {
    ok: true,
    file,
    written: plan.written,
    skipped: plan.skipped,
    held: plan.held,
    unparsed: plan.unparsed,
    ...(noPairs && {
      message:
        plan.unparsed > 0
          ? `The stub had no KEY=value lines. Its text was saved as a comment in ${file}.`
          : "The stub had no KEY=value lines. There were only comments or blank lines, so nothing was written.",
    }),
    warnings,
  };
}

/**
 * Resolves symlinks so the git guard and the write see the file that will really change: the
 * target itself when it exists, else its folder. Everything that can fail is checked here,
 * before the claim.
 */
async function resolveTarget(path: string, file: string, project?: string): Promise<string | Failure> {
  try {
    const existing = await stat(path);
    if (!existing.isFile()) return fail("invalid", `${file} isn't a regular file. ${NOTHING_CONSUMED}`);
    const real = await realpath(path);
    const boundary = checkProjectBoundary(real, project);
    if (boundary) return boundary;
    await access(real, constants.R_OK);
    await access(dirname(real), constants.W_OK);
    return real;
  } catch (error) {
    const permission = projectPermissionFailure(error, project);
    if (permission) return permission;
    if (!isNotFound(error)) {
      return fail("error", `Can't read or replace ${file} (${errorCode(error)}). ${NOTHING_CONSUMED}`);
    }
  }

  try {
    // A missing file and a dangling symlink both make stat fail with ENOENT. MCP cannot
    // check a dangling link's real target, so refuse instead of reading through it later.
    if (project !== undefined) {
      const entry = await lstat(path).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (entry?.isSymbolicLink()) {
        return fail("invalid", `${file} is a symlink whose target doesn't exist. ${NOTHING_CONSUMED}`);
      }
    }
    const dir = await realpath(dirname(path));
    if (!(await stat(dir)).isDirectory()) throw Object.assign(new Error(), { code: "ENOTDIR" });
    const target = join(dir, basename(path));
    const boundary = checkProjectBoundary(target, project);
    if (boundary) return boundary;
    await access(dir, constants.W_OK);
    return target;
  } catch (error) {
    const permission = projectPermissionFailure(error, project);
    if (permission) return permission;
    if (isNotFound(error)) return fail("invalid", `The folder for ${file} doesn't exist. ${NOTHING_CONSUMED}`);
    return fail("error", `Can't create ${file} (${errorCode(error)}). ${NOTHING_CONSUMED}`);
  }
}

/** MCP cannot use a target denied by the filesystem; CLI keeps its contextual errors. */
function projectPermissionFailure(error: unknown, project?: string): Failure | null {
  const code = errorCode(error);
  if (project === undefined || (code !== "EACCES" && code !== "EPERM")) return null;
  return fail("invalid", `The env file or its folder can't be accessed. ${NOTHING_CONSUMED}`);
}

/**
 * Check both resolved-file and resolved-parent targets before permission preflight. Both paths
 * are realpaths, so compare them with exact case; path.relative ignores case on Windows.
 * Exported for tests with either platform's separator.
 */
export function checkProjectBoundary(target: string, project?: string, separator: string = sep): Failure | null {
  if (project === undefined) return null;
  const prefix = project.endsWith(separator) ? project : `${project}${separator}`;
  if (target === project || !target.startsWith(prefix)) {
    return fail("invalid", `The env file must stay inside the project directory, including symlink targets. ${NOTHING_CONSUMED}`);
  }
  return null;
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
