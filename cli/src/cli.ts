// Argument parsing, output, and exit codes. Commands return results; this file decides how they
// look. Output names keys and files only. Every byte `run` writes goes through `Output`, which
// redacts links, fragments, keys, and ids (R6); the only exceptions are the payloads a command
// exists to print: the link from `push` and the public id from `init`/`id`.

import type { Writable } from "node:stream";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { withClient } from "../../src/core/api";
import type { Transport } from "../../src/core/ticket";
import { checkStub, type CheckSuccess } from "./check";
import { createIdentity, loadIdentity, type InitSuccess } from "./identity";
import { resolveOrigin } from "./links";
import { startMcpServer } from "./mcp";
import { pullStub, type PullSuccess } from "./pull";
import { pushStub, type PushSuccess } from "./push";
import { redact, redactDeep } from "./redact";
import { EXIT_RUN_FAILED, runCommand } from "./run";
import { installSkill, isSkillTarget, renderSkill, targetLabel, tildePath, type InstallSuccess } from "./skill";
import { exitCodeFor, fail, isFailure, type Failure } from "./result";
import { packageVersion, readPackageVersion } from "./version";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
  makeTransport: (origin: string) => Transport;
  readStdin: () => Promise<string>;
  readPrompt: () => Promise<string | Failure>;
  /**
   * For `stubs run`: where the command's output goes (through the masker, not the redactor,
   * which would blank every URL in a test run) and what it gets as stdin.
   */
  run: { stdout: Writable; stderr: Writable; stdin: "inherit" | "ignore" };
  /** Package version for the skill; undefined reads package.json, null simulates a failure. */
  version?: string | null;
}

export const USAGE = `stubs: move one-time .env stubs into a project without printing the values.

Usage:
  stubs pull <link>|- [--to <file>] [--overwrite] [--allow-tracked] [--origin <url>] [--json]
      Open the stub and merge its values into <file> (default .env.local).
      Keys already in the file are skipped unless --overwrite. Prints key names only.
      Refuses (exit 5) if git would not ignore the file, unless --allow-tracked.
      With -, the link is read from stdin (pbpaste | stubs pull -), so it never sits in
      the process list or your shell history.

  stubs run [--from <file>]... -- <cmd> [args...]
      Run <cmd> with the values from <file> (default .env.local) in its environment, and
      replace every one of those values in its output with [stubs:KEY]. Values shorter than
      6 characters (true, 3000) aren't masked. There's no flag to show the values; open the
      file yourself. A key already set in your environment, or one that changes which code
      programs run (NODE_OPTIONS, LD_PRELOAD, GIT_*...), stops the run. Exit code is the
      command's own; 125 if stubs failed, 126 if <cmd> isn't executable, 127 if it isn't found.

  stubs check <link>|- [--origin <url>] [--json]
      Say whether the stub is still sealed, without opening it.

  stubs push [file|--prompt] [--ttl 5m|1h|1d|7d] [--to <id>] [--origin <url>] [--json]
      Seal <file> (default .env.local, "-" for stdin) into a new stub and print its link.
      --prompt reads hidden multiline .env input in your terminal. Ctrl-D finishes;
      Ctrl-C cancels. Cannot be combined with a file or "-".
      With --to, the stub is locked: only the machine holding that stubs id can open it.

  stubs init [--force] [--json]
      Create this machine's identity for locked stubs and print its public id.
      Stored in $XDG_CONFIG_HOME/stubs/identity (default ~/.config/stubs/identity), mode 0600.

  stubs id [--json]
      Print this machine's public id (stubs1...). Give it to whoever sends you stubs.

  stubs mcp
      Run an MCP server on stdio with the pull_stub and check_stub tools.

  stubs skill show
  stubs skill install [--target claude|codex] [--force] [--protect] [--json]
      Print or install the agent skill that teaches Claude Code and Codex to pull stubs safely.
      --protect also denies Claude Code's file tools reading .env and .env.* files.
      Run \`stubs skill --help\` for details.

Options:
  --origin <url>   Trust links from this origin (default stubs.talix.app over https, or STUBS_ORIGIN).
  --json           Print exactly one JSON object on stdout.
  -h, --help       Show this help.
  -v, --version    Show the version.

Exit codes:
  0 done   2 void   3 bad input   4 network   5 refused (git guard)
  6 tampered   7 uncertain (retry tells which)   1 anything else
`;

export const SKILL_USAGE = `stubs skill: the agent skill for Claude Code and Codex.

Usage:
  stubs skill show
      Print the skill (SKILL.md), pinned to this version of @talix/stubs.

  stubs skill install [--target claude|codex] [--force] [--protect] [--json]
      Install it as skills/stubs/SKILL.md for each agent:
        claude  ~/.claude/skills/stubs/SKILL.md
        codex   $CODEX_HOME/skills/stubs/SKILL.md (default ~/.codex)
      Without --target, installs for each agent whose home folder exists. Repeat --target for
      both. An older stubs skill is updated in place; any other file at that path is left alone
      (exit 5) unless --force.
      --protect also adds permission rules to ~/.claude/settings.json ($CLAUDE_CONFIG_DIR is
      honoured) that deny Claude Code reading .env and .env.* files and the stubs config
      folder. The rules cover the Read, Edit, and Write tools, and cat, head, tail, sed, and
      tee in Bash; not a script that opens the file itself. Existing settings are kept; a file
      that isn't valid JSON, or that has a Read exception after the stubs rules, is left alone
      (exit 5) and the rules are printed to add by hand. Codex has no equivalent rule; see the
      README.
`;

type Options = NonNullable<ParseArgsConfig["options"]>;

const COMMON: Options = {
  origin: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const COMMANDS: Record<string, Options> = {
  pull: { ...COMMON, to: { type: "string" }, overwrite: { type: "boolean" }, "allow-tracked": { type: "boolean" } },
  check: COMMON,
  push: { ...COMMON, ttl: { type: "string" }, to: { type: "string" }, prompt: { type: "boolean" } },
  init: { json: COMMON.json!, help: COMMON.help!, force: { type: "boolean" } },
  id: { json: COMMON.json!, help: COMMON.help! },
  mcp: { help: COMMON.help! },
  skill: {
    json: COMMON.json!,
    help: COMMON.help!,
    force: { type: "boolean" },
    protect: { type: "boolean" },
    target: { type: "string", multiple: true },
  },
  // Not --env-file: Node reads that flag itself, anywhere on the command line before --, and
  // would load the file into this process before any of this code runs. The launcher in
  // dist/stubs.js puts a -- in front of the script so a typo can't do that either.
  run: { help: COMMON.help!, from: { type: "string", multiple: true } },
};

/** Flags a parse error may name back; anything else is "an unknown flag", since it could be a link. */
const KNOWN_FLAGS = new Set([
  ...Object.values(COMMANDS).flatMap((options) =>
    Object.entries(options).flatMap(([name, option]) => [`--${name}`, ...(option.short ? [`-${option.short}`] : [])]),
  ),
  "--version",
  "-v",
]);

/** The single path to the streams. */
interface Output {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  json: (value: unknown) => void;
  /** Unredacted: only for a link or id the command was asked to produce. */
  deliberate: { stdout: (text: string) => void; stderr: (text: string) => void };
  /** For showing paths under it as ~/... */
  home: string;
}

function output(io: Io): Output {
  return {
    stdout: (text) => io.stdout(redact(text)),
    stderr: (text) => io.stderr(redact(text)),
    // Redact field by field so the serialized form stays valid JSON.
    json: (value) => io.stdout(`${JSON.stringify(redactDeep(value))}\n`),
    deliberate: { stdout: io.stdout, stderr: io.stderr },
    home: io.home,
  };
}

type Value = string | boolean | (string | boolean)[] | undefined;
type Values = Record<string, Value>;

export async function run(argv: string[], io: Io): Promise<number> {
  const out = output(io);
  const [command, ...rest] = argv;
  // `run` has no --json of its own; one after -- belongs to the command.
  const wantsJson = command !== "run" && argv.includes("--json");

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    (command === undefined ? out.stderr : out.stdout)(USAGE);
    return command === undefined ? 3 : 0;
  }
  if (command === "--version" || command === "-v") {
    out.stdout(`${packageVersion()}\n`);
    return 0;
  }

  const options = COMMANDS[command];
  if (!options) return report(fail("invalid", `Unknown command. Run \`stubs --help\`.`), wantsJson, out);

  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: rest, options, allowPositionals: true, strict: true }));
  } catch (error) {
    const code = report(fail("invalid", argumentError(error, command)), wantsJson, out);
    return command === "run" ? EXIT_RUN_FAILED : code;
  }
  if (values.help) {
    out.stdout(command === "skill" ? SKILL_USAGE : USAGE);
    return 0;
  }
  const json = values.json === true;

  if (command === "run") {
    const envFiles = Array.isArray(values.from) ? values.from.map(String) : undefined;
    const result = await runCommand(
      { command: positionals, envFiles },
      { cwd: io.cwd, env: io.env, ...io.run, warn: (message) => out.stderr(`stubs: ${message}\n`) },
    );
    if (typeof result === "number") return result;
    out.stderr(`stubs: ${result.message}\n`);
    return result.exitCode ?? EXIT_RUN_FAILED;
  }

  const identity = { env: io.env, home: io.home };

  if (command === "mcp") {
    if (positionals.length > 0) return report(fail("invalid", "mcp takes no arguments."), false, out);
    await startMcpServer({ cwd: io.cwd, env: io.env, home: io.home, makeTransport: io.makeTransport });
    return 0;
  }

  if (command === "init" || command === "id") {
    if (positionals.length > 0) return report(fail("invalid", `${command} takes no arguments.`), json, out);
    if (command === "init") return report(await createIdentity(identity, { force: values.force === true }), json, out);
    const local = await loadIdentity(identity);
    if (local === null) return report(fail("invalid", "No identity yet. Run `stubs init`."), json, out);
    return report(isFailure(local) ? local : { ok: true, publicId: local.publicId }, json, out);
  }

  if (command === "skill") return runSkill(positionals, values, io, out);

  const origin = resolveOrigin(stringValue(values.origin), io.env.STUBS_ORIGIN);
  if (isFailure(origin)) return report(origin, json, out);
  const transport = withClient(io.makeTransport(origin), "cli");

  if (command === "push") {
    if (positionals.length > 1) return report(fail("invalid", "push takes at most one file."), json, out);
    const lockTo = stringValue(values.to);
    const result = await pushStub(
      { origin, file: positionals[0], prompt: values.prompt === true, ttl: stringValue(values.ttl), lockTo },
      { transport, cwd: io.cwd, readStdin: io.readStdin, readPrompt: io.readPrompt },
    );
    const code = report(result, json, out);
    if (!json && result.ok && result.locked) out.deliberate.stderr(`Locked to ${lockTo?.trim()}.\n`);
    return code;
  }

  if (positionals.length !== 1) {
    return report(fail("invalid", `${command} needs exactly one link.`), json, out);
  }
  let link = positionals[0]!;
  if (link === "-") {
    link = (await io.readStdin()).trim();
    if (link === "") return report(fail("invalid", "Nothing on stdin. Pipe the link in, or pass it as an argument."), json, out);
  }

  if (command === "check") {
    return report(await checkStub({ link, origin }, { transport, identity }), json, out);
  }

  const result = await pullStub(
    {
      link,
      origin,
      to: stringValue(values.to),
      overwrite: values.overwrite === true,
      allowTracked: values["allow-tracked"] === true,
    },
    { transport, cwd: io.cwd, identity },
  );
  return report(result, json, out);
}

async function runSkill(positionals: string[], values: Values, io: Io, out: Output): Promise<number> {
  const [sub, ...extra] = positionals;
  const json = values.json === true;
  const version = io.version === undefined ? readPackageVersion() : io.version;
  if (sub === "help" && extra.length === 0) {
    out.stdout(SKILL_USAGE);
    return 0;
  }

  if (sub === "show") {
    if (extra.length > 0 || values.target !== undefined || values.force || values.protect || json) {
      return report(fail("invalid", "skill show takes no options. Run `stubs skill --help`."), json, out);
    }
    const rendered = renderSkill(version);
    if (typeof rendered !== "string") return report(rendered, false, out);
    // Deliberate: the skill is public text, and redaction would mangle its example link.
    out.deliberate.stdout(rendered);
    return 0;
  }

  if (sub === "install") {
    if (extra.length > 0) return report(fail("invalid", "skill install takes no arguments."), json, out);
    const requested = Array.isArray(values.target) ? values.target.map(String) : [];
    const unknown = requested.find((target) => !isSkillTarget(target));
    if (unknown !== undefined) {
      return report(fail("invalid", "--target must be claude or codex. Run `stubs skill --help`."), json, out);
    }
    const result = await installSkill(
      { targets: requested.filter(isSkillTarget), force: values.force === true, protect: values.protect === true },
      { home: io.home, cwd: io.cwd, env: io.env, version },
    );
    return report(result, json, out);
  }

  return report(fail("invalid", "Unknown skill command. Run `stubs skill --help`."), json, out);
}

type IdSuccess = { ok: true; publicId: string };
type Success = PullSuccess | CheckSuccess | PushSuccess | InitSuccess | IdSuccess | InstallSuccess;
type CommandResult = Success | Failure;

function report(result: CommandResult, json: boolean, out: Output): number {
  const deliberate = result.ok && ("link" in result || "publicId" in result);
  if (json && deliberate) out.deliberate.stdout(`${JSON.stringify(result)}\n`);
  else if (json) out.json(result);
  else if (!result.ok) out.stderr(`stubs: ${result.message}\n`);
  else describe(result, out);
  return exitCodeForResult(result);
}

/** Like exitCodeFor, but a void `check` exits 2 so scripts can branch on it. */
export function exitCodeForResult(result: CommandResult): number {
  if (!result.ok && result.exitCode !== undefined) return result.exitCode;
  if (result.ok && "status" in result && result.status === "void") return 2;
  return exitCodeFor(result);
}

function describe(result: Success, out: Output): void {
  if ("installed" in result) {
    const verbs = { installed: "Installed for", updated: "Updated for", unchanged: "Already up to date for" };
    for (const item of result.installed) {
      out.stdout(`${verbs[item.status]} ${targetLabel(item.target)}: ${tildePath(item.path, out.home)}\n`);
    }
    for (const item of result.protected ?? []) {
      if (item.target === "codex") {
        out.stdout("Codex: no deny rule installed; it has no equivalent setting (see the README).\n");
      } else if (item.status === "unchanged") {
        out.stdout(`Claude Code's file tools already deny .env reads: ${tildePath(item.path, out.home)}\n`);
      } else {
        out.stdout(`Claude Code's file tools now deny .env reads: ${tildePath(item.path, out.home)} (added ${item.rules.join(", ")})\n`);
      }
    }
    return;
  }
  if ("publicId" in result) {
    out.deliberate.stdout(
      "created" in result
        ? `Your stubs id: ${result.publicId}\nShare it with whoever sends you locked stubs.\n`
        : `${result.publicId}\n`,
    );
    return;
  }
  if ("link" in result) {
    out.deliberate.stdout(`${result.link}\n`);
    out.stderr(`Sealed. Opens once, valid until ${localTime(result.expiresAt)}.\n`);
    return;
  }
  if ("status" in result) {
    out.stdout(
      result.status === "sealed" ? `Sealed. Valid until ${localTime(result.expiresAt)}.\n` : "Void (opened or expired).\n",
    );
    return;
  }
  const lines = [
    result.message ?? `Pulled ${count(result.written.length, "value")} into ${result.file}${list(result.written)}`,
  ];
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${count(result.skipped.length, "existing key")}${list(result.skipped)}`);
  }
  if (result.held.length > 0) {
    lines.push(`Held back ${count(result.held.length, "value")} with a $ reference${list(result.held)}`);
  }
  if (result.unparsed > 0 && !result.message) {
    lines.push(`Kept ${count(result.unparsed, "unparsed line")} as comments in ${result.file}.`);
  }
  out.stdout(lines.join("\n") + "\n");
  for (const warning of result.warnings) out.stderr(`stubs: warning: ${warning}\n`);
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const list = (keys: string[]) => (keys.length > 0 ? `: ${keys.join(", ")}` : "");
const localTime = (ms: number) => new Date(ms).toLocaleString();
const stringValue = (value: Value) => (typeof value === "string" ? value : undefined);

/** parseArgs messages echo what was typed, which might be a link; name only known flags. */
function argumentError(error: unknown, command: string): string {
  const help = `Run \`stubs ${command} --help\`.`;
  const message = error instanceof Error ? error.message : "";
  const typed = /option '(-{1,2}[^\s'=]+)/i.exec(message)?.[1];
  const flag = typed && KNOWN_FLAGS.has(typed) ? typed : undefined;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    if (command === "run" && typed?.startsWith("--env-file")) {
      return `stubs run doesn't take --env-file: that's a Node flag, and Node would read the file itself. Use --from <file>. ${help}`;
    }
    if (command === "run" && !flag) return `stubs run was given an unknown flag. Put -- before the command: stubs run -- <cmd> [args]. ${help}`;
    return flag ? `stubs ${command} doesn't take ${flag}. ${help}` : `stubs ${command} was given an unknown flag. ${help}`;
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") return `Bad value for ${flag ?? "an option"}. ${help}`;
  return `Couldn't read the arguments. ${help}`;
}
