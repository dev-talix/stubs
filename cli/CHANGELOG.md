# Changelog

## 0.6.0

- `pull`, `run`, and `push` accept `--env <name>` to use `.env.<name>` in the current directory.
  Names are literal. Invalid names and conflicting file options are refused before any action.

## 0.5.2

- Plain-text pulls now explain that the stub had no `KEY=value` lines and its text was
  saved as comments. CLI JSON and MCP results include the same explanation in `message`.
  Values stay out of output, and successful pulls still exit `0`.

## 0.5.1

- The npm README is shorter and opens with a banner. Command internals, masking details,
  startup guards, and the full refused-key list moved to `docs/cli-reference.md` on GitHub.
  No CLI behavior changes.

## 0.5.0

- `stubs push --prompt` reads hidden multiline `.env` input from your terminal without a
  plaintext file. Ctrl-D finishes; Ctrl-C cancels without creating a stub. It accepts up to
  32 KB of UTF-8, restores the terminal before sending, and refuses redirected input or a
  file argument. Existing file and piped stdin input are unchanged. Run it in your own
  terminal and give the agent only the resulting link. Bracketed paste stays hidden through
  its closing marker; embedded control keys discard the input and require a separate
  Ctrl-D or Ctrl-C after the paste ends.

- MCP `pull_stub` checks its resolved env target against the real project directory before
  opening a stub. File symlinks and parent symlinks that point outside are refused, including
  the default `.env.local`. Dangling file symlinks are refused without replacing them.
  Symlinks within the project still work. The CLI's user-chosen `--to` targets are unchanged.

- npm launchers on Windows invoke `node --` directly, so `stubs` no longer requires `sh`
  in cmd.exe or PowerShell. The early `--` still stops Node loading startup flags passed
  to Stubs. Direct Unix execution now requires `/usr/bin/env -S`, such as GNU coreutils
  8.30 or later. With an older or minimal `env`, use `node --` before the installed script
  path. Packed-package launcher tests and CI cover Linux, macOS, and Windows.

- `run` refuses env-file compiler selectors, Erlang and Lua startup hooks, proxy keys, and
  `DOCKER_HOST`, including lowercase names and versioned `LUA_INIT_*` hooks. The error covers
  code selection and traffic redirection. Deliberate shell configuration remains available;
  the README lists the blocked keys and the limits of this blocklist.

## 0.4.0

- `stubs run -- <cmd>` runs a command with the env file's values in its environment and
  replaces every one of them in its output with `[stubs:KEY]`, so a tool that prints its config
  on error leaves the placeholder in an agent's transcript, not the secret. Values are caught
  across write boundaries with any pause between them, and in their JSON-escaped (including
  `\u00e4`-style), URL-encoded, and base64 forms. Every value in the file is masked, including
  a key set twice. Values shorter than 6 characters aren't masked. There is no flag that shows
  the values. A key that changes which code programs run (`LD_*`, `NODE_*`, `GIT_*`,
  `npm_config_*`, `ZDOTDIR`, and the rest of the list in the README) or one the environment
  already sets to a different value stops the run with exit 125. Another file is read with
  `--from`, not `--env-file`, which Node would read itself before `stubs` starts; the `stubs`
  executable is now a one-line sh launcher that execs `node -- stubs.js`, so an `--env-file`
  typo is refused before Node can read the file on direct, npm bin, global npm, and `pnpm dlx`
  launches. Npx needs an early separator: use `npx -y --loglevel=warn --` before the pinned
  package name. The `--loglevel=warn` keeps npm 12 from echoing your command line.
  Plain npx without that `--`, and raw `node dist/stubs.js`, are unprotected. On Windows
  without `sh`, use `node -- dist/stubs.js` with the installed path. The command
  runs in its own process group, which `run` manages: forwarded signals, leftovers when the
  command exits, and a reader going away all end in `SIGKILL` for anything still there a
  second later, and the run returns once the group is empty; a crash in `stubs` kills the
  group on the way out. A descendant that starts its own session is out of reach and the docs
  say so. Messages from `run` never repeat the command or a file name.
- `stubs skill install --protect` adds Claude Code permission rules that deny its file tools
  reading `.env` and `.env.*` files and the stubs config folder. Opt-in; it reports what it
  added, refuses a settings file it can't parse, one with a `Read(!...)` exception after a
  stubs rule, or a `settings.json` symlink whose target is missing, and says so.
- The docs say what this protects and what it doesn't: values stay out of logs and transcripts
  by accident; an agent that sets out to read them still can.
- `skill install` honours `CLAUDE_CONFIG_DIR` for the Claude Code skill folder, as it already
  did `CODEX_HOME` for Codex.
- The skill now routes every command that needs the values through `run`, says `push` is how
  to share them on, and allows reading a `.env*` file only when the user explicitly asks.
- A crash prints one fixed line instead of a stack trace, including uncaught exceptions,
  unhandled rejections, and closed output pipes.
- URL masking covers upper- and lower-case percent escapes with either `%20` or `+` for
  spaces, including encoded slashes and literal plus signs split across output writes.

## 0.3.0

- No runtime dependencies. The MCP SDK and zod are bundled into `dist/stubs.js` at build time.
  Before, installing the pinned package still resolved them (79 packages) with caret ranges at
  install time, so the pin didn't cover what ran in the process holding the decrypted values.
  Now it does.
- `pull_stub` over MCP only writes inside the server's working directory. An absolute `file`,
  or one that climbs above it with `..`, is refused before any network call. The CLI's `--to`
  is unchanged.
- `stubs pull -` and `stubs check -` read the link from stdin, keeping it out of the process
  list and shell history.
- The skill asks for the recipient's stubs id before `push` and says why: an unlocked link is
  the secret itself.
- Pulled values that look like a `$NAME` reference are held back as comments and reported as
  `held`, with a warning. `dotenv-expand` (Vite, Next.js) expands them regardless of quoting, so
  a hostile stub could have copied an existing secret into a variable a build publishes. The
  README's claim that single quotes stopped expansion was wrong.
- The README documents that `npx` prefers a project-local `@talix/stubs` when one is installed,
  and recommends a global install for checkouts you don't trust.

## 0.2.0

- `stubs skill install` installs a Stubs agent skill for Claude Code and Codex: when a stubs
  link shows up, the agent pulls it with this exact CLI version and never reads `.env*` files.
  Re-running is safe and upgrades an older stubs skill in place. `stubs skill show` prints it.
- `pull` and `check` refuse anything that isn't a plain stub link (`https://<site>/t#…`): no
  query string, credentials, or characters outside the link alphabet. Together with the skill's
  own check, a crafted link can't break out of the shell command an agent runs.
- `skill install` won't write through a symlinked skill folder or file without `--force`.
- Every command in the docs, the site, and the skill now pins an exact version
  (`@talix/stubs@0.2.0`) instead of fetching whatever is newest.

## 0.1.0

First release.

- `stubs pull <link>`: opens a one-time stub and writes its values into `.env.local`, printing
  key names only. Refuses files git would track; keeps skipped values as comments; recovers to
  `~/.config/stubs/recovered/` if the write fails after the stub opened.
- `stubs check <link>`: status without consuming.
- `stubs push [file]`: encrypts a `.env` and prints a link; `--to <stubs id>` locks it to a
  machine.
- `stubs init` / `stubs id`: a per-machine identity (X25519, stored like an SSH key) for locked
  stubs.
- `stubs mcp`: MCP server with `pull_stub` and `check_stub` for Claude Code, Cursor, and Codex.
- Every line of output passes a redaction step, so a link pasted as a path or a flag can't be
  echoed by an error.
