# Agent tooling: `@talix/stubs`

Spec for the CLI, the MCP server, the agent docs, and machine-bound stubs. Implementation
traces to the numbered requirements here.

## Goal

An agent handed a stubs link moves the values into the project, uses them, and passes them on
without the values landing in its context, its transcript, its logs, or any tool output by
accident: not from the CLI, and not from the commands the agent runs with them. That's the
scope of this version. An agent running arbitrary code as the user can still read the file;
keeping the values out of its reach altogether is TAL-142.

## Package

- npm name `@talix/stubs`, bin `stubs`. Lives in `cli/` as a pnpm workspace package.
- Node `>=20`. Runtime dependencies: `@modelcontextprotocol/sdk` and `zod` only. Argument
  parsing uses `node:util` `parseArgs`.
- Built with esbuild into `cli/dist/stubs.js` (ESM, `--platform=node`, relative imports
  bundled, packages external). The bundle pulls `src/core/*` and `src/shared/protocol.ts` from
  the repo root; those files are the same code the browser runs.
- `files` in `package.json` lists only `dist/` and `README.md`. `npm pack --dry-run` must show
  nothing else, and nothing under `dist/` may contain a `.env` value, a key, or a link.

## Commands

All commands read the link from an argument. A link is `https://<origin>/t#<fragment>`.

### R1 `stubs pull <link> [--to <file>] [--overwrite] [--allow-tracked] [--origin <url>] [--json]`

1. Parse the link. Origin must equal `https://stubs.talix.app` unless `--origin` (or
   `STUBS_ORIGIN`) says otherwise. A different origin exits `3` without any network call.
2. Open the stub through the core Ticket module (`inspectTicket` is not needed; call
   `revealTicket` directly). The transport is Node's global `fetch` with the same headers the
   browser sends.
3. Parse the plaintext with `parseDotenv`. Lines that aren't `KEY=VALUE` (and aren't blank or
   comments) can't be merged by key; they're appended verbatim, each prefixed `# unparsed: `,
   so nothing from a consumed stub is lost, and reported as `unparsed` (count).
4. Merge into `--to` (default `.env.local`, relative to the current directory):
   - Existing file is parsed with `parseDotenv`. A key that already exists is **skipped**, not
     an error: the pull still succeeds (exit `0`), writes the new keys, and reports the skipped
     names, and keeps the incoming value as a comment line (`# stubs skipped (already set):
     KEY=value`) so nothing from the consumed stub is lost. `--overwrite` replaces the existing
     line's value in place instead, re-encoding only the replaced lines. A conflict can never
     fail a pull, because by then the stub is consumed and failing would lose it.
   - New keys are appended as `KEY=VALUE` lines after the existing content. A value is written
     bare when it's safe, otherwise in the first quote style that holds it literally for both
     npm `dotenv` and our parser: single quotes, then backticks, then double quotes (only for
     values with newlines, escaped `\n`). Existing content is preserved byte for byte (except
     lines replaced by `--overwrite`).
   - Writes go to a temp file in the same directory, mode `0600`, then `rename` over the
     target. An existing file keeps its mode if it's already `0600` or stricter; otherwise it
     becomes `0600`.
5. Git guard, run against the target's real path (symlinks resolved): if the target is inside
   a git work tree and `git check-ignore -q <file>` says it isn't ignored, exit `5` before
   writing, unless `--allow-tracked`. The message says exactly what to add to `.gitignore`.
   Not in a repo: no guard. If git can't answer (not installed, timed out) and a `.git` entry
   exists above the target, refuse rather than guess.
   If the existing file has a malformed line (an unclosed quote), the pull still succeeds but
   reports a warning, since dotenv parsers may swallow keys appended after it.
6. Output. Human (default) and `--json`. Both list key names only. There is no flag that prints
   a value, and no error message may include one.
   - Human: `Pulled 3 values into .env.local: API_KEY, DB_URL, SECRET` then
     `Skipped 1 existing key: PORT` when relevant.
   - JSON, one object on stdout:
     `{"ok":true,"file":".env.local","written":["API_KEY"],"skipped":["PORT"],"unparsed":0}`
     or `{"ok":false,"code":"void","message":"..."}`.
7. The stub is consumed the moment the server answers the claim, so every local check that can
   run before it (origin, target path, git guard) must. If the write itself fails after the
   claim (disk, permissions), the CLI writes the values atomically to
   `$XDG_CONFIG_HOME/stubs/recovered/<timestamp>-<basename>` (default `~/.config/stubs/`),
   mode `0600`, outside any repository, and names that path in the error rather than losing
   them.

### R2 `stubs check <link> [--origin <url>] [--json]`

Status only; never consumes. Human: `Sealed. Valid until <local time>.` or `Void (opened or
expired).` JSON: `{"ok":true,"status":"sealed","expiresAt":<ms>}` or `{"ok":true,"status":"void"}`.
A void stub exits `2` (the JSON still says `ok: true`), so scripts can branch on the exit code.

### R3 `stubs push [file] [--ttl 5m|1h|1d|7d] [--origin <url>] [--json]`

Reads `file` (default `.env.local`, or stdin when `file` is `-`), creates a stub through
`issueTicket`, prints the link (human) or `{"ok":true,"link":"...","expiresAt":<ms>}`. Refuses
an empty file (`3`). Default TTL `1h`.

### R4 `stubs mcp`

Starts an MCP server on stdio (`@modelcontextprotocol/sdk`, `StdioServerTransport`). Server
name `stubs`. Tools:

- `pull_stub` — input `{link: string, file?: string, overwrite?: boolean}`; output is the R1
  JSON object. Description: "Open a one-time Stubs link and write its values into the
  project's env file. Returns key names only. Never read or print the env file afterwards;
  run commands that need the values with `npx -y --loglevel=warn -- @talix/stubs@0.4.0 run -- <cmd>`, which
  masks them in the output."
- `check_stub` — input `{link: string}`; output is the R2 JSON object.

No `push` tool. File paths resolve against the server's working directory. The server inherits
`STUBS_ORIGIN`. Tool errors are returned as MCP tool results with `isError: true` and the R1
error object, never thrown.

#### MCP pull boundary, TAL-143

Requirement and owner: TAL-143 requires the MCP-selected env file to stay inside the real
project directory. The MCP boundary implementer owns this record. CLI target selection,
git guard policy, recovery storage, and isolation from hostile concurrent filesystem changes
are outside this change. TAL-142 covers keeping values out of an agent's reach altogether.

Intended and implemented path: `createMcpServer` in `cli/src/mcp.ts` checks the input path
and enables `PullDeps.confineToProject`. `pullStub` in `cli/src/pull.ts` resolves the project
root with `realpath(cwd)` and passes it to `resolveTarget`. That resolver checks the canonical
env target with `checkProjectBoundary` before permission preflight, the git guard, and the
`revealTicket` claim. The boundary helper handles both existing-file and new-file targets.
The same canonical target goes to the git guard, `readExisting`, and `writeFileAtomic`.
Existing file links resolve to the file; a new file resolves through its parent directory.
A dangling final file symlink is invalid because its canonical destination cannot be checked.
For MCP, `EACCES` or `EPERM` during target resolution or permission preflight returns a fixed
`invalid` response. This also covers an inaccessible target inside the project. The
`projectPermissionFailure` helper handles both resolver error branches; CLI permission errors
retain their contextual `error` response.

Acceptance examples in `cli/test/mcp.test.ts`: the default `.env.local` and an explicit file
link outside return `invalid`; an outside parent link for a new file and a sibling whose name
shares the project prefix return `invalid`. These cases leave the server request list empty,
the stored stub sealed, and the outside files unchanged. An unreadable outside file and an
unwritable outside parent also return `invalid` before permission checks. A non-searchable
outside parent returns `invalid` for existing and new files without sending a request or
changing the outside directory. A dangling link stays a link and
doesn't consume. Inside-project file and parent links work, as does a symlinked project cwd.
Changing the original file link during claim still writes the canonical target checked before
claim. That last case does not establish protection against concurrent changes to canonical
parent directories. Failures after claim still use R1 recovery outside the project.

`cli/test/commands.test.ts` verifies that the CLI can still select an outside target and follow
an outside file symlink. `cli/test/binary.test.ts` exercises default-target rejection through
the built MCP server on stdio with real HTTP transport and checks that no claim was sent.
The commands suite also verifies that an inaccessible outside target keeps the CLI's
permission `error` response without consumption or mutation.

Verification: base commit `51314c631d45378cad7c4405f1b31f789ffea46b`, uncommitted changes on
`tal-143/mcp-realpath-boundary`, macOS with Node 22.23.2 and host pnpm 12.9.1. The pre-fix run failed
the five new rejection examples and passed the CLI regression, recorded in
`/tmp/stubs-tal143-20261008/behavior-red.log`. The post-fix focused run passed 184 tests in
`behavior-green.log`. The permission-ordering regression failed both new permission cases in
`permission-red.log`; the revised complete CLI suite passed 429 tests, including the CLI
build and stdio MCP case, in `cli-suite-revised.log`. Typecheck and site build passed again in
`typecheck-revised.log` and `site-build-revised.log`. After the final permission-error mapping,
both non-searchable-parent cases failed before the fix in `search-permission-red.log`, while
the CLI regression passed. The focused MCP and commands suites now pass all 111 tests in
`search-permission-green.log`, and repository typecheck passes in
`typecheck-search-permission.log`. The implementer did not rerun the complete suite or builds after that mapping. Logs and
uncommitted `dirty.diff` are under `/tmp/stubs-tal143-20261008/`.

Integration verification by the parent: all 739 repository tests passed across 31 files,
including the CLI, worker and client projects. Root typecheck, CLI build, site build and
`git diff --check` passed. Logs are
`/tmp/stubs-card-review-20261008/integration-verified-tests.log`,
`integration-verified-typecheck.log`, `integration-verified-cli-build.log` and
`integration-verified-site-build.log` in the same directory. The tested input is pinned by
`integration-gate-manifest.json`; final changes to this record only reconcile gate metadata.
Final source reviews reported no remaining findings in `tal143-final-review.json` and
`tal140-resync-review.json`. The complete final dirty artifacts are `tal143-final.patch`,
`tal140-final.patch` and `integration-final.patch`. Source and test bytes match the gate
manifest; Windows console behavior, unsupported paste terminals and deployment were NOT RUN.
No lint script is configured.

Commands run from the repository root with package-manager auto-install disabled:

```sh
export npm_config_manage_package_manager_versions=false
export npm_config_verify_deps_before_run=false
export PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
export WRANGLER_SEND_METRICS=false
node node_modules/vitest/vitest.mjs run --project cli
pnpm --config.verifyDepsBeforeRun=false typecheck
pnpm --config.verifyDepsBeforeRun=false build
```

### R5 Exit codes

| Code | Meaning | JSON `code` |
|---|---|---|
| 0 | done | |
| 2 | void: already opened or expired | `void` |
| 3 | bad input: malformed link, wrong origin, empty file, unknown flag | `invalid` |
| 4 | network: no response, timeout, or rate limited; nothing consumed, retry is safe | `network` |
| 5 | refused: the target file isn't ignored by git (see R1.5) | `refused` |
| 6 | tampered: opened but wouldn't decrypt (now void) | `tampered` |
| 7 | uncertain: connection dropped mid-open; retry tells which | `uncertain` |
| 1 | anything else | `error` |

### R6 Never leak

- No code path writes a value to stdout or stderr. Tests run the built binary against a fake
  server with canary values and assert the canaries appear in neither stream, with and without
  `--json`, on success and on every failure path that happens after the claim.
- The link's fragment never appears in output either (errors say "the link", not the link).
  Every string that reaches stdout, stderr, or an MCP result passes one redaction step that
  blanks fragments, URLs, 43-character base64url runs, and public ids, so a link passed where
  a path or flag was expected can't be echoed by a Node or argument-parser error.
- A crash never prints a stack trace or an error message: the entry point handles rejected
  promises, uncaught exceptions, unhandled rejections, and stream errors with one fixed line.
  An error object could carry anything the command was holding.
- Error messages name keys and paths only. Malformed lines in an env file are reported by line
  number, never by content, since the content may hold part of a value.

### R12 `stubs run [--from <file>]... -- <cmd> [args...]`

After a pull, the agent runs tests, dev servers, and scripts. Many tools print their config or
environment on error, so the pulled values would land in the transcript anyway (TAL-141).
`run` is the layer between the command and whoever reads its output.

1. Everything after `--` is the command. Flags before it belong to `stubs`; a flag after it
   (including `--json` and `--help`) goes to the command. Without `--`, a flag the command
   needs is an argument error whose message says to add `--`.
2. Reads `--from` (default `.env.local`, repeatable) with `parseDotenv`. Not `--env-file`:
   Node 22 scans the whole command line for that flag until `--` and loads the file before
   any CLI code runs, `NODE_OPTIONS` included. Two layers: `--env-file`
   and `--env-file-if-exists` (space or `=`) are refused with a message naming `--from`, and
   the shipped `dist/stubs.js` starts with a sh/JS polyglot launcher (`cli/build.mjs`) that
   execs `node -- stubs.js "$@"`, so Node's scan stops before our arguments on every launch
   that goes through the executable: the direct executable, the npm bin link, a global npm
   install, and `pnpm dlx`. Npx needs its own early separator:
   `npx -y --loglevel=warn -- @talix/stubs@0.4.0 run -- <cmd>`. `--loglevel=warn` stops npm 12's
   `npm notice run` line, which echoes the whole command line. Plain npx without that `--` is unprotected:
   the Node process running npx can load the file and execute its hooks before our launcher
   starts. Raw `node dist/stubs.js` is also unprotected because it skips the launcher.
   Windows shims from npm's `cmd-shim` read the shebang and run `sh stubs.js`, which needs
   `sh` on `PATH`, as in Git Bash or WSL. Without `sh`, use `node -- dist/stubs.js` with the
   installed script path. The `--` before that path stops Node's scan. A missing file is an
   error, not an empty run: the agent should pull first. A key the environment already sets
   to a different value stops the run (exit `125`, keys named): two sources of truth. The same
   value is fine. Keys matched by the refusal list in `cli/src/run.ts` (prefixes `LD_`,
   `DYLD_`, `NODE_` except `NODE_ENV`, `NPM_CONFIG_`, `YARN_`, `PNPM_`, `BUN_`, `PYTHON`,
   `PERL`, `RUBY`, `GEM_`, `BUNDLE_`, `GIT_`, `JAVA_`, `_JAVA_`, `JDK_JAVA_`, `DOTNET_`,
   `XDG_`; names `PATH`, `HOME`, `SHELL`, `ENV`, `BASH_ENV`, `ZDOTDIR`, `SHELLOPTS`,
   `BASHOPTS`, `IFS`, `PS4`, `PROMPT_COMMAND`, `CDPATH`, `CLASSPATH`, `PAGER`, `MANPAGER`,
   `EDITOR`, `VISUAL`, `BROWSER`, `LESSOPEN`, `LESSCLOSE`; case-insensitive) stop the run the
   same way, so a hostile stub can't use `GIT_CONFIG_*`, `npm_config_node_options`, or
   `ZDOTDIR` to make the command run its code. It's a blocklist, so it closes the known hooks,
   not every possible one.
3. Spawns the command with stdin inherited and stdout and stderr piped through a masker, one
   per stream, into this process's stdout and stderr. On POSIX the command gets its own
   process group (`detached`), which also drops its controlling terminal. That group is what
   `run` manages; a descendant that calls `setsid` leaves it and is out of reach. Nothing is
   written to disk.
4. Masking (`cli/src/mask.ts`): every value of 6 or more characters anywhere in the files
   (every pair, including a key set twice, plus the values `pull` kept as comments and the text
   of lines the parser can't read) is replaced by `[stubs:KEY]`. Each value is also searched
   for JSON-escaped (JavaScript style, and with non-ASCII as `\uXXXX` in lower and upper
   case), URL-encoded (upper and lower-case hex, each with `%20` or `+` for spaces), base64 and base64url at
   all three byte alignments (the characters that depend only on the value's bytes, plus the
   padded tail for a value that ends the string), and line by line for multi-line values.
   Matching is on bytes, longest value first, so binary output passes through and a value that
   starts with another value wins. A chunk whose tail could be the start of a value is held
   until the next chunk decides or the stream ends; the held tail is never longer than the
   longest value, and no timer releases it, since a timer is a way to get a value out in two
   halves. The JSON forms are exactly: JavaScript's; non-ASCII as lower-case `\uXXXX`
   (Python's `json.dumps`); Go's default, which escapes `<`, `>`, `&`, U+2028 and U+2029 and
   keeps other non-ASCII; and each of those with upper-case hex digits. Tests cover each and
   assert that a form escaping quotes numerically (as .NET's default encoder does) is not
   covered; the docs say the same. Values shorter than 6 characters aren't masked: documented as not protected. Greedy
   left-to-right matching means that when one value's tail overlaps another's head in the
   output, the second one's remainder can show: documented.
5. Exit code is the command's own; a signal exits `128 + signal number`. `SIGINT`, `SIGTERM`,
   and `SIGHUP` are forwarded to the command's process group, and each arms `SIGKILL` for the
   group one second later, so a command that ignores the signal still ends (exit `137`). When
   the command exits, the group gets `SIGTERM` and the same `SIGKILL` deadline, and the run
   polls `kill(-pgid, 0)` until the group is empty before returning, so a leftover without
   pipes can't outlive it. `close` waits for the output pipes, which a descendant in another
   session can hold forever. So after exit the run waits a second and a half at a time, and
   gives up only when nothing is queued anywhere in the relays (source buffer, masker,
   sink buffer, sink needing drain): output backed up behind a slow reader keeps the wait
   going until it's delivered. A detached process that escaped the group and keeps writing
   will keep `run` waiting until it stops, because run never cuts output silently. The timer
   is cleared when `close` wins so a short command returns at once. Giving up closes the
   pipes from this side, settles both relays (each is a
   race against an "abandoned" promise, so nothing is left pending and `main.ts` always gets
   a code), drops a held tail, warns with a fixed line, and exits with the command's code, or
   `125` if that was `0`. Every relay failure stops the group first; `EPIPE` (the reader went
   away) then exits `141`, as a shell reports a writer killed by `SIGPIPE`, and any other
   error is rethrown once the group is gone, so it reaches the fixed-line crash path (exit
   `1`) even when the command handled its output error and ignored `SIGTERM`. A `process.on("exit")`
   handler kills the group with `SIGKILL`, so the crash path in `main.ts` (`process.exit(1)`)
   takes the command with it. Following `env(1)`: `125` when `stubs` failed before or while
   starting the command, `126` when it isn't executable, `127` when it isn't found. No
   `--json`.
6. No flag turns masking off. A TTY check was tried and rejected: `pty.fork` passes it, so it
   isn't consent. A person who wants the values opens the file.
7. Messages from `run` are fixed text plus key names. The command, its arguments, and the
   `--from` paths are never echoed (a nonexistent command named after a value would leak it);
   files are called `.env.local` (a constant) or `the --from file` / `--from file number N`.
8. Tests feed canary values through the built binary and the in-process CLI and assert they
   appear in neither stream, including when the command prints them in pieces (also under a
   real PTY from `script(1)`), JSON-escaped in both styles, URL-encoded, base64-encoded,
   inside a Basic auth header, by dumping the env file, with a duplicate key, and in `run`'s
   own errors. `cli/test/mask.test.ts` checks the four URL forms across chunk boundaries;
   `cli/test/binary.test.ts` checks lower-case hex with `+` spaces in both output streams,
   split across paused writes, while preserving the command's exit code.
   Process-group tests through the built binary cover a grandchild left behind,
   one that ignores `SIGTERM` and holds no pipe, `SIGTERM` to `stubs` with a command that
   ignores it, a crash while supervising, a reader that goes away against a command that
   ignores `EPIPE`, a descendant that left the session while holding the pipes, a hostile
   `NODE_OPTIONS` in a `--from` file with the binary run as the executable it ships as, every
   `--env-file` spelling with `--require` and inline `--import` hooks and a canary-named
   missing file through the launcher (as the file and through a symlink like npm's bin), and
   through real npx with the skill's early `--`, using a local tarball offline with a private
   npm cache. The same npx probes without the early `--` confirm the leak. Tests also cover a
   196 KB write with the reader stalled for three seconds (all bytes delivered, exit code
   kept), a short command returning in under a second, a relay error against a command that
   handles it and ignores `SIGTERM`, and a `GIT_CONFIG_*` stub against real `git`. Every spawned process is killed in teardown
   (`cli/test/helpers/leftovers.ts`), so a failing test can't leave one behind.

### R13 `stubs skill install --protect`

The skill is an instruction; a host setting is a control over the host's own tools. Where the
agent host has one, the installer can add it, opt-in only, and says exactly what it changed.

- Claude Code: appends to `permissions.deny` in `~/.claude/settings.json` (or
  `$CLAUDE_CONFIG_DIR/settings.json`, which also moves the skill; created if missing):
  `Read(.env)`, `Read(.env.*)`, and `Read(<config dir>/**)` as `~/.config/stubs/**` or an
  absolute `//path` when `XDG_CONFIG_HOME` moves it. Not `.env*`, which would also catch
  `.envrc`. Claude Code applies Read deny rules to Read, Edit, and Write, to `cat`, `head`,
  `tail`, `sed`, and `tee` in Bash, and to redirections, at any depth under the project; not
  to a script that opens the file itself or a `grep -r`. No `Read(!.env.example)` exceptions:
  per the Claude Code docs an exception carves paths out of every rule listed before it in the
  same file, including the user's, so adding one could reopen a template file they had denied.
  Rules are ordered, so a stubs rule counts as in place only if no `Read(!...)` exception
  follows it; if one does (the user's `Read(.env.*)` then `Read(!.env.local)`), the installer
  refuses (exit `5`, nothing written) and names the rule and the exception, rather than
  appending a second copy that would quietly undo the user's choice or reporting protection
  that isn't there. Only missing rules are appended, at the end. Everything else in the file
  is kept as parsed. A file that isn't valid JSON (an empty file included), or whose
  `permissions` or `permissions.deny` has the wrong shape (`null`, or a list with a non-string
  entry), is refused the same way and the rules are printed to
  add by hand. A symlinked `settings.json` is written through to its target, so a dotfiles
  link survives; a link whose target is missing is refused (`lstat` after `realpath` fails),
  since writing would replace the link with a plain file. The file keeps its mode (`0644`
  when new).
- Codex: no equivalent the installer can add safely (file-level denies are permission
  profiles, beta, which replace the sandbox configuration). Reported as unsupported, nothing
  written; the README points at the profile syntax.
- Rejected: shipping a `PreToolUse` hook in the skill's frontmatter. Hooks register only once
  the skill is invoked, run a shell command per tool call, and would need to parse Bash to
  catch `cat`; the settings rule is always on and maintained by the host. Also rejected:
  editing settings without a flag, and `Bash(cat .env*)` rules, which are prefix matches that
  `head`, `./.env`, or `/bin/cat` walk around.

### What this version claims, and what it doesn't

Everything above keeps values out of logs and transcripts by accident. None of it stops an
agent that sets out to read them: it runs arbitrary code as the user, so it can open the file
from a script, print a value in an encoding the masker doesn't know (hex, UTF-16, split across
stdout and stderr), or write to the terminal device by name. The docs say this plainly. A hard
guarantee needs the values kept out of the agent's reach altogether, which is TAL-142.

## Agent docs (R7)

- `cli/README.md`: install, the four commands, exit codes, the no-leak guarantee, MCP setup
  for Claude Code (`claude mcp add stubs -- npx -y @talix/stubs@0.4.0 mcp`), Cursor
  (`.cursor/mcp.json`), and Codex (`~/.codex/config.toml` `[mcp_servers.stubs]`).
- The root `README.md` gets a short "For agents" section linking there, plus this `AGENTS.md`
  snippet:

  > When given a link on stubs.talix.app, run `npx -y --loglevel=warn -- @talix/stubs@0.4.0 pull <link>` (or the
  > `pull_stub` tool). It writes the values into `.env.local` and prints only the key names.
  > Never `cat`, read, or print `.env*` files.

- The opened-ticket page in the web app (`src/client/reveal.ts`) and the sealed page get one
  line of fine print: "Pulling this into a project? `npx -y --loglevel=warn -- @talix/stubs@0.4.0 pull <link>` writes it
  straight to .env.local." On the sealed page the COPY button copies the command with the real link (it's the
  recipient's own), but on screen the link reads `<this link>`: the key must not sit on
  screen for screenshots and screen shares. The opened page shows the generic form.

## Wave 2: machine-bound stubs

A stub locked to a recipient can sit in a chat log safely: the link alone can't open it.

### R8 Identity

- `stubs init` creates `~/.config/stubs/identity` (honouring `XDG_CONFIG_HOME`), mode `0600`,
  directory `0700`. Content: line 1 `# stubs identity v1`, line 2 the X25519 private key as
  base64url PKCS#8 (48 bytes, 64 chars; what WebCrypto exports and imports everywhere).
  Refuses to overwrite unless `--force`. Prints the public id.
- `stubs id` prints the public id: `stubs1` + base64url(X25519 public key, 32 bytes), 49 chars.
- Same model as SSH keys: a file with tight permissions, no OS keychain, no passphrase.

### R9 Link format v2

Derivation of id / claim secret / AES key from a ticket key is unchanged (that's the storage
format, salt `env-ticket/v1`). Only the link changes: v2 carries the ticket key wrapped to the
recipient instead of bare.

- Fragment: `v2.<ephemeralPub>.<wrapped>`; `ephemeralPub` is a fresh X25519 public key (43
  chars), `wrapped` is `iv(12) || AES-GCM(ticketKey)(32 + 16 tag)` = 60 bytes, 80 chars.
- Wrap key: `shared = X25519(ephemeralPriv, recipientPub)`;
  `wrapKey = HKDF-SHA256(shared, salt "env-ticket/link-v2", info ephemeralPub || recipientPub, 256 bits)`;
  `wrapped = AES-GCM(wrapKey, iv, ticketKey, aad "v2")`. Ephemeral private key is discarded.
- Unwrap (recipient): same derivation with the identity's private key. A failed unwrap is
  reported as "not locked to this machine" (exit `3`), nothing consumed.
- Wrapping happens before the server is asked to create the ticket, so a recipient id that is
  well-formed but unusable (a degenerate curve point) fails as `bad_recipient` with nothing
  created. The sender sees a message; the recipient should run `stubs id` again.
- `parseTicketFragment` learns v2 and returns `{kind: "locked", ephemeralPub, wrapped}`.
  `issueTicket` takes an optional `lockTo: recipientPublicId`. The server is untouched.
- Browser support: wrapping needs X25519 in WebCrypto (current Chrome, Safari 17+, Firefox 130+).
  If `crypto.subtle` can't import X25519, the lock field explains the browser is too old.

### R10 Surfaces

- Web create page: optional "LOCK TO A RECIPIENT" field under VALID FOR, accepting a public id
  (`stubs1…`), validated on input. When set, the printed ticket says "LOCKED" and the fine print
  says the link only opens on that machine with `stubs pull`.
- Web `/t` page on a v2 link: "LOCKED STUB" screen, not void, not consumed: it shows the
  `npx -y --loglevel=warn -- @talix/stubs@0.4.0 pull <link>` command with a copy button and explains why the browser
  can't open it. No status call is made (the browser can't prove possession).
- `stubs pull` unwraps with the local identity before proceeding as R1. `stubs check` likewise.
- `stubs push --to <public id>` locks from the CLI.

### R11 Tests for wave 2

Round trip in core tests (wrap with a recipient key, unwrap, derive, open against the fake
server); wrong identity fails without a network call; a tampered wrapped blob fails; the e2e
test in workerd opens a locked stub through the real Worker; browser tests cover the lock field
and the LOCKED screen.

## Out of scope

Push over MCP, multiple identities per machine, passphrase-protected identities, OS keychains,
Windows ACLs beyond what `fs.chmod` gives, self-hosting docs, a `run` tool over MCP (the agent
has a shell), a pseudo-terminal for `run` (needs a native dependency), masking values in forms
other than the ones listed in R12, process groups on Windows, and anything that stops the
command itself from sending a value elsewhere: `run` is a filter on output, not a sandbox
(TAL-142).
