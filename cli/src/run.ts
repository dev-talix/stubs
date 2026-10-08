// `stubs run -- <cmd>`: runs a command with the env file's values in its environment, and
// masks those values in everything the command prints. The values exist only in the child's
// environment and in this process's memory; nothing is written anywhere. Nothing this file
// prints ever includes the command, an argument, or a file name given on the command line:
// any of those could be a value.

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { pairsOf, parseDotenv } from "../../src/core/dotenv";
import { HELD_PREFIX, SKIPPED_PREFIX, UNPARSED_PREFIX } from "./env-file";
import { Masker, needlesFor, type Needle } from "./mask";
import { DEFAULT_ENV_FILE } from "./pull";
import { errorCode, fail, type Failure } from "./result";

/** Exit codes borrowed from env(1): stubs itself failed, the command couldn't run, not found. */
export const EXIT_RUN_FAILED = 125;
export const EXIT_NOT_EXECUTABLE = 126;
export const EXIT_NOT_FOUND = 127;
/** What a shell reports for a command killed by SIGPIPE: our reader went away mid-output. */
const EXIT_READER_GONE = 128 + osConstants.signals.SIGPIPE;

/**
 * Known env keys that select code or redirect traffic: dynamic loaders, runtime startup hooks
 * and module paths, shell startup files, config locations that tools read commands from,
 * programs tools hand control to (compiler, pager, editor), proxies, and the Docker daemon.
 * Only file-supplied values are checked; deliberate shell configuration remains available.
 * Matched case-insensitively, since Windows names are. The prefixes are wide on purpose: a run
 * refused over NODE_NO_WARNINGS costs one message; a loader hook that gets through costs the
 * machine. It's still a blocklist, and the docs say so.
 */
const REFUSED_PREFIXES = [
  "LD_", "DYLD_", "NODE_", "NPM_CONFIG_", "YARN_", "PNPM_", "BUN_", "PYTHON", "PERL", "RUBY", "GEM_", "BUNDLE_",
  "GIT_", "JAVA_", "_JAVA_", "JDK_JAVA_", "DOTNET_", "XDG_", "LUA_INIT_",
];
const REFUSED_NAMES = new Set([
  "PATH", "HOME", "SHELL", "ENV", "BASH_ENV", "ZDOTDIR", "SHELLOPTS", "BASHOPTS", "IFS", "PS4", "PROMPT_COMMAND",
  "CDPATH", "CLASSPATH", "PAGER", "MANPAGER", "EDITOR", "VISUAL", "BROWSER", "LESSOPEN", "LESSCLOSE",
  "CC", "CXX", "ERL_AFLAGS", "ERL_FLAGS", "ERL_ZFLAGS", "LUA_INIT", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "DOCKER_HOST",
]);
/** The one NODE_ name that is app config, not a Node hook. */
const ALLOWED_NAMES = new Set(["NODE_ENV"]);

export function isRefusedKey(key: string): boolean {
  const name = key.toUpperCase();
  if (ALLOWED_NAMES.has(name)) return false;
  return REFUSED_NAMES.has(name) || REFUSED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** How long the command's process group gets after SIGTERM before SIGKILL. */
const GRACE_MS = 1000;
/** How often to check whether the group is empty. */
const POLL_MS = 25;
/**
 * On POSIX the command gets its own process group, so a signal reaches everything it started
 * that stayed in the group. A descendant that starts its own session (setsid, or Node's
 * `detached`) leaves the group and is out of reach from here; that's a documented limit.
 */
const OWN_GROUP = process.platform !== "win32";

export interface RunOptions {
  command: string[];
  /** Env files (`--from`), read in order. Default `.env.local`. */
  envFiles?: string[];
}

export interface RunDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: Writable;
  stderr: Writable;
  stdin: "inherit" | "ignore";
  /** One line of stderr for anything the user should know before the command runs. */
  warn: (message: string) => void;
}

export interface LoadedEnv {
  /** Values the command gets. */
  values: Map<string, string>;
  /** Everything to mask: every value in the files, including ones kept as comments. */
  needles: Needle[];
}

/**
 * Reads the env files. Every value in them is masked, whichever one the command ends up with:
 * a key set twice, values in the comments `pull` leaves behind (skipped, held back, unparsed),
 * and lines the parser can't read (an unclosed quote). A key matched by the refusal list, or
 * one the environment already sets to something else, stops the run: the first could select
 * code or redirect traffic, and the second has two sources of truth.
 */
export async function loadEnvFiles(files: string[], deps: Pick<RunDeps, "cwd" | "env">): Promise<LoadedEnv | Failure> {
  const values = new Map<string, string>();
  const needles: Needle[] = [];
  const refused = new Set<string>();
  const conflicting = new Set<string>();
  for (const [index, file] of files.entries()) {
    const name = fileLabel(file, index, files.length);
    let text: string;
    try {
      text = await readFile(resolve(deps.cwd, file), "utf8");
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return fail("invalid", `${name} doesn't exist. Pull a stub first, or check --from.`);
      if (code === "EISDIR") return fail("invalid", `${name} is a folder, not a file.`);
      return fail("error", `Couldn't read ${name} (${code}).`);
    }
    const lines = parseDotenv(text);
    for (const pair of pairsOf(lines)) {
      needles.push(...needlesFor(pair.key, pair.value));
      const existing = deps.env[pair.key];
      if (isRefusedKey(pair.key)) refused.add(pair.key);
      else if (existing !== undefined && existing !== pair.value) conflicting.add(pair.key);
      else values.set(pair.key, pair.value);
    }
    for (const line of lines) {
      if (line.kind === "invalid") needles.push(...needlesFor("unparsed", line.text));
    }
    for (const line of text.split(/\r\n|\r|\n/)) {
      const trimmed = line.trim();
      for (const prefix of [SKIPPED_PREFIX, HELD_PREFIX]) {
        if (!trimmed.startsWith(prefix)) continue;
        for (const pair of pairsOf(parseDotenv(trimmed.slice(prefix.length)))) {
          needles.push(...needlesFor(pair.key, pair.value));
        }
      }
      if (trimmed.startsWith(UNPARSED_PREFIX)) needles.push(...needlesFor("unparsed", trimmed.slice(UNPARSED_PREFIX.length)));
    }
  }
  if (refused.size > 0) {
    const [list, it] = named(refused);
    return fail("refused", `${list} can't come from an env file: keys like that can change which code programs run or where they send traffic. Take ${it} out of the file, or set ${it} in your shell on purpose.`);
  }
  if (conflicting.size > 0) {
    const [list, it] = named(conflicting);
    return fail("refused", `Already set in your environment with a different value: ${list}. Unset ${it} (env -u KEY) or take ${it} out of the file, so the command gets one value.`);
  }
  return { values, needles };
}

/** Names the default file, which is a constant, and otherwise only the flag: a path could be a value. */
function fileLabel(file: string, index: number, total: number): string {
  if (file === DEFAULT_ENV_FILE) return DEFAULT_ENV_FILE;
  return total === 1 ? "The --from file" : `--from file number ${index + 1}`;
}

/** The keys as a list, and the pronoun the rest of the sentence needs. */
function named(keys: Set<string>): [string, "it" | "them"] {
  return [[...keys].join(", "), keys.size === 1 ? "it" : "them"];
}

/** Runs the command. Resolves with its exit code, or a failure when it never started. */
export async function runCommand(options: RunOptions, deps: RunDeps): Promise<number | Failure> {
  const [command, ...args] = options.command;
  if (command === undefined || command === "") {
    return fail("invalid", "Nothing to run. Put the command after --: stubs run -- <cmd> [args].");
  }

  const files = options.envFiles?.length ? options.envFiles : [DEFAULT_ENV_FILE];
  const loaded = await loadEnvFiles(files, deps);
  if ("ok" in loaded) return loaded;
  if (loaded.values.size === 0) deps.warn(`The env file${files.length === 1 ? "" : "s"} set no values for the command.`);

  const childEnv = { ...deps.env, ...Object.fromEntries(loaded.values) };
  const child = spawn(command, args, { cwd: deps.cwd, env: childEnv, stdio: [deps.stdin, "pipe", "pipe"], detached: OWN_GROUP });
  const closed = new Promise<void>((done) => child.once("close", () => done()));

  // The command's process group lives exactly as long as the command. A termination signal
  // sent to this process is forwarded to the group, and so is a reader going away; either way
  // the group gets GRACE_MS, then SIGKILL. Whatever the command leaves in the group when it
  // exits gets the same treatment, and the run doesn't return until the group is empty. If
  // this process dies first (a crash, or a signal nobody handled) the group gets SIGKILL on
  // the way out.
  let killTimer: NodeJS.Timeout | undefined;
  const armKill = () => {
    killTimer ??= setTimeout(() => signalTree(child, "SIGKILL"), GRACE_MS);
  };
  const stop = () => {
    signalTree(child, "SIGTERM");
    armKill();
  };
  const onExit = () => signalTree(child, "SIGKILL");
  process.once("exit", onExit);
  const forwarded = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(
    (signal) =>
      [
        signal,
        () => {
          signalTree(child, signal);
          armKill();
        },
      ] as const,
  );
  for (const [signal, handler] of forwarded) process.on(signal, handler);

  // A relay failing means the output can't be delivered, so the group is stopped first,
  // whatever the reason. If whoever reads our output went away (EPIPE), that's what a shell
  // pipeline's SIGPIPE would do, and the run reports it the way a shell does. Anything else is
  // a real failure and surfaces as one, once the group is gone.
  const relays = [relay(child.stdout, loaded.needles, deps.stdout), relay(child.stderr, loaded.needles, deps.stderr)];
  let readerGone = false;
  const relayed = Promise.all(relays.map((item) => item.done)).catch((error: unknown) => {
    stop();
    if (errorCode(error) !== "EPIPE") throw error;
    readerGone = true;
  });
  // Awaited below on every path; this only keeps an early failure from counting as unhandled.
  relayed.catch(() => {});

  try {
    const exit = await new Promise<number | Failure>((done) => {
      child.once("error", (error) => {
        const code = errorCode(error);
        if (code === "ENOENT") done(fail("invalid", "Command not found.", { exitCode: EXIT_NOT_FOUND }));
        else if (code === "EACCES") done(fail("invalid", "Command not executable.", { exitCode: EXIT_NOT_EXECUTABLE }));
        else done(fail("error", `Couldn't start the command (${code}).`));
      });
      child.once("exit", (code, signal) => done(signal ? 128 + (osConstants.signals[signal] ?? 0) : (code ?? 1)));
    });
    // The command is done; stop what it left in the group. `close` waits for the output pipes,
    // which a leftover could be holding open until it's stopped, and which a process that left
    // the group can hold open for good. So once nothing has moved through the relays for a
    // while, the pipes are closed from this side. Output still queued behind a slow reader is
    // not that: it keeps the wait going until it's through.
    stop();
    const drained = await closesInTime(closed, () => relays.some((item) => item.busy()));
    if (!drained) for (const item of relays) item.abandon();
    await relayed;
    if (readerGone) return EXIT_READER_GONE;
    if (!drained) {
      deps.warn("Something the command started kept its output open after the command exited. The run stopped waiting for it and dropped what was left.");
      return typeof exit === "number" && exit !== 0 ? exit : EXIT_RUN_FAILED;
    }
    return exit;
  } finally {
    await groupGone(child);
    clearTimeout(killTimer);
    process.off("exit", onExit);
    for (const [signal, handler] of forwarded) process.off(signal, handler);
  }
}

/**
 * Waits for the command's pipes to close. Resolves false once they've stayed open for a
 * while with nothing queued in the relays (a writer out of reach is holding them); keeps
 * waiting while output is still working its way to a slow reader.
 */
async function closesInTime(closed: Promise<void>, busy: () => boolean): Promise<boolean> {
  for (;;) {
    let timer: NodeJS.Timeout | undefined;
    const expired = await Promise.race([
      closed.then(() => false),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(true), GRACE_MS + 500);
      }),
    ]);
    clearTimeout(timer);
    if (!expired) return true;
    if (!busy()) return false;
  }
}

/**
 * Resolves once nothing is left in the command's process group. SIGTERM has been sent by the
 * time this runs; the group gets GRACE_MS from now, then SIGKILL, then a little longer to
 * disappear. Something that survives SIGKILL isn't ours to fix.
 */
async function groupGone(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const deadline = Date.now() + GRACE_MS;
  let killed = false;
  while (anyLeft(child.pid)) {
    if (!killed && Date.now() >= deadline) {
      signalTree(child, "SIGKILL");
      killed = true;
    }
    if (killed && Date.now() >= deadline + GRACE_MS) return;
    await sleep(POLL_MS);
  }
}

/** Whether any process is left in the group (on POSIX) or the command itself is (elsewhere). */
function anyLeft(pid: number): boolean {
  try {
    process.kill(OWN_GROUP ? -pid : pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signals the command and, on POSIX, everything in its process group. Quiet once it's gone. */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (OWN_GROUP) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // ESRCH: nothing left to signal.
  }
}

interface Relay {
  /** Settles when the pipe ends, fails, or is abandoned; never left hanging. */
  done: Promise<void>;
  /** Whether bytes are still queued anywhere between the command and the reader. */
  busy: () => boolean;
  /** Closes the command's side and settles `done`; a held tail is dropped. */
  abandon: () => void;
}

/** Pipes `source` into `sink` through a fresh masker, never ending the sink. */
function relay(source: Readable, needles: Needle[], sink: Writable): Relay {
  const masker = new Masker(needles);
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const out = masker.push(chunk);
      if (out.length > 0) this.push(out);
      callback();
    },
    flush(callback) {
      const rest = masker.flush();
      if (rest.length > 0) this.push(rest);
      callback();
    },
  });
  let release: () => void = () => {};
  const abandoned = new Promise<void>((done) => (release = done));
  return {
    // Settling on `abandoned` first means a later rejection from the torn-down pipeline is
    // taken as handled, which it is.
    done: Promise.race([pipeline(source, transform, sink, { end: false }), abandoned]),
    busy: () =>
      source.readableLength > 0 ||
      transform.writableLength > 0 ||
      transform.readableLength > 0 ||
      sink.writableLength > 0 ||
      sink.writableNeedDrain,
    abandon: () => {
      release();
      source.destroy();
      transform.destroy();
    },
  };
}
