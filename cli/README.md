# @talix/stubs

Pull a one-time [Stubs](https://stubs.talix.app) link straight into a project. `stubs pull`
opens the link, decrypts the values on your machine, and writes them into `.env.local`. It
prints the key names and nothing else, so an agent can run it without the values ever landing
in its context, its transcript, or its logs. `stubs run -- <cmd>` then runs tests, dev servers,
and scripts with those values in their environment and masks every one of them in the output,
and `stubs push` seals the file into a new link without printing it. Together they keep the
values out of logs and transcripts by accident. They don't stop an agent that sets out to read
them; see [What this protects and what it doesn't](#what-this-protects-and-what-it-doesnt).

## Install

**For agents, the easiest setup is the skill.** One command installs it for Claude Code and
Codex; from then on, any stubs link you hand the agent gets pulled the safe way:

```bash
npx -y --loglevel=warn -- @talix/stubs@0.4.0 skill install
```

Run it without installing:

```bash
npx -y --loglevel=warn -- @talix/stubs@0.4.0 pull 'https://stubs.talix.app/t#v1.…'
```

Or install it globally and use the `stubs` bin:

```bash
npm i -g @talix/stubs@0.4.0
stubs pull 'https://stubs.talix.app/t#v1.…'
```

Needs Node 20 or later.

## Commands

### `stubs pull <link>`

Opens the stub and merges its values into an env file. The stub is used up the moment it opens.
Pass `-` instead of the link to read it from stdin (`pbpaste | stubs pull -`), which keeps the
link out of the process list and your shell history.

| Flag | What it does |
|---|---|
| `--to <file>` | File to write. Default `.env.local`, relative to the current directory. |
| `--overwrite` | Replace keys that already exist in the file. Without it, existing keys are skipped and reported. |
| `--allow-tracked` | Write even if git would track the file. |
| `--origin <url>` | Trust a server other than `https://stubs.talix.app`. Same as `STUBS_ORIGIN`. |
| `--json` | Print one JSON object instead of text. |

```
$ stubs pull 'https://stubs.talix.app/t#v1.…'
Pulled 3 values into .env.local: API_KEY, DB_URL, SECRET
Skipped 1 existing key: PORT
```

```json
{"ok":true,"file":".env.local","written":["API_KEY"],"skipped":["PORT"],"held":[],"unparsed":0,"warnings":[]}
```

How the write works:

- New keys are appended after the existing content. What's already in the file stays byte for
  byte.
- The file is written to a temp file next to it, then renamed into place. It ends up mode
  `0600`. A file that's already `0600` or stricter keeps its mode.
- Values are written bare when that's safe, otherwise quoted in a style that npm `dotenv` and
  the stubs parser both read literally (single quotes first, then backticks, then double quotes
  for values with newlines).
- A value that looks like a `$NAME` or `${NAME}` reference is never written live. Tools that
  expand `.env` values (Vite, Next.js through `dotenv-expand`) ignore quoting and would replace
  it with another variable's value, so a stub saying `PUBLIC_X=$PRIVATE_KEY` could copy your
  existing secret into a variable a build publishes. Such values are kept as comments
  (`# stubs held back ($ reference): KEY=…`), listed as `held`, and explained in `warnings`.
  If the `$` is literal, uncomment the line yourself.
- A key that's already in the file is skipped, not an error: the pull still succeeds, writes
  the other keys, lists the skipped names, and keeps each skipped value in a comment
  (`# stubs skipped (already set): KEY=…`) so nothing from the used-up stub is lost.
  `--overwrite` replaces those values in place instead, touching only those lines.
- If the existing file has a malformed line (an unclosed quote, say), the keys are still
  appended, but the result carries a warning: dotenv parsers may not read past that line.
- Lines in the stub that aren't `KEY=VALUE` are appended as comments prefixed `# unparsed: `
  so nothing is lost, and counted as `unparsed`.
- If the write itself fails after the stub opened (disk full, permissions), the values go to
  `~/.config/stubs/recovered/<timestamp>-<file>` with mode `0600`, outside any repository, and
  the error names that path. Move the values and delete it.

Everything that can be checked before opening is checked first: the link, the origin, the
target path, and the git guard. A problem there exits without using the stub.

**Locked stubs.** A link that starts with `/t#v2.` is locked to one machine (see
[`stubs init`](#stubs-init)). `pull` and `check` unwrap it with this machine's identity before
any network call. Without an identity, or with the wrong one, they exit `3` and nothing is
consumed.

### `stubs run -- <cmd> [args...]`

Runs a command with the env file's values in its environment, and replaces every one of those
values in the command's stdout and stderr with `[stubs:KEY]` before it reaches the terminal, or
the agent. This is how an agent runs tests, a dev server, or a migration after a pull: plenty
of tools print their config or environment when something fails, and the placeholder is what
lands in the transcript instead of the secret.

```
$ stubs run -- pnpm test
  FAIL  connects to [stubs:DATABASE_URL]: ECONNREFUSED
```

| Flag | What it does |
|---|---|
| `--from <file>` | Read this file instead of `.env.local`. Repeat it to read several. |

There is no flag that shows the values. If you want to see them, open the file yourself.

The flag is `--from`, not `--env-file`, for a reason: Node reads `--env-file` itself, anywhere
on the command line before a `--`, and loads that file before stubs can refuse it. A file
carrying `NODE_OPTIONS` can then run its own code. The `stubs` executable is a shell launcher
that execs `node -- stubs.js`. That protects the direct executable, the `node_modules/.bin`
link, a global npm install, and `pnpm dlx`: Node's scan stops before your arguments, so all
four spellings of `--env-file` and `--env-file-if-exists` are refused with a message naming
`--from`.

For npx, always use `npx -y --loglevel=warn -- @talix/stubs@0.4.0 run -- <command>`. The first
`--` stops Node's scan in npx itself. `--loglevel=warn` stops npm 12 printing `npm notice run`
with your whole command line before stubs starts, while still showing npm's real warnings and
errors. Plain npx without that early `--` is unprotected: it can load the
file and run its hooks before our launcher starts. Raw `node dist/stubs.js` is also
unprotected because it skips the shell launcher. On Windows, npm's shim needs `sh` on
`PATH`, as in Git Bash or WSL. From `cmd.exe` or PowerShell without `sh`, use
`node -- node_modules/@talix/stubs/dist/stubs.js run -- <command>`. Keep the `--` before the
script path. Stubs reads the env file itself through `--from`.

How it works:

- Everything after `--` is the command and its arguments, flags included. Put `--` before the
  command every time; a flag before it belongs to `stubs`.
- The command's stdin, exit code, and signals are passed through. The exit code is the
  command's own; a command killed by a signal exits `128` plus the signal number, as a shell
  would. `125` means `stubs` itself failed (the message on stderr says why), `126` that the
  command isn't executable, `127` that it wasn't found. If whoever reads the output goes away
  (`stubs run -- cmd | head -1`), the command is stopped and the run exits `141`, as a shell
  pipeline would.
- Both output pipes are relayed through the masker. If writing to your terminal or pipe fails
  for some other reason than the reader going away (a full disk, say), the run stops the
  command, prints the fixed crash line, and exits `1`.
- A key the file sets to something your environment already sets stops the run (exit `125`)
  and the message names the key. Two sources of truth is how a test runs against the wrong
  database; unset the key (`env -u KEY stubs run ...`) or take it out of the file. The same
  key with the same value is fine.
- Keys that change which code a program runs, rather than how it behaves, stop the run too:
  anything starting with `LD_`, `DYLD_`, `NODE_` (except `NODE_ENV`), `NPM_CONFIG_`, `YARN_`,
  `PNPM_`, `BUN_`, `PYTHON`, `PERL`, `RUBY`, `GEM_`, `BUNDLE_`, `GIT_`, `JAVA_`, `_JAVA_`,
  `JDK_JAVA_`, `DOTNET_`, or `XDG_`, and `PATH`, `HOME`, `SHELL`, `ENV`, `BASH_ENV`,
  `ZDOTDIR`, `SHELLOPTS`, `BASHOPTS`, `IFS`, `PS4`, `PROMPT_COMMAND`, `CDPATH`, `CLASSPATH`,
  `PAGER`, `MANPAGER`, `EDITOR`, `VISUAL`, `BROWSER`, `LESSOPEN`, and `LESSCLOSE`, in any
  case. A stub could otherwise use them to run its own code on the machine that pulls it: a
  `GIT_CONFIG_*` triple that sets `core.sshCommand`, say, or `npm_config_node_options`. The
  list is wide on purpose and it's still a blocklist; a value the command reads and acts on
  itself is up to the command.
- Masking works on bytes, so binary output passes through, and a value split across two
  writes is still caught: a chunk that ends with the start of a value is held until the rest
  arrives or the command exits, however long that takes. There is no timer that lets it out
  early, so a prompt that ends with the first letters of a value shows up when the command
  writes more or exits. Each value is also masked in the forms tools commonly print it in,
  which are exactly these: JSON as JavaScript's `JSON.stringify` writes it; the same with
  non-ASCII characters as `\u00e4`, as Python's `json.dumps` does; Go's `encoding/json`
  default, which keeps non-ASCII but escapes `<`, `>`, `&`, U+2028 and U+2029 as `\u003c`
  and so on; each of those three with upper-case hex digits; URL-encoded with upper or
  lower-case hex and with `+` for spaces; base64 and base64url at every alignment (so a
  password inside a `Basic` auth header is caught); and line by line for multi-line values
  such as PEM keys. Tests cover each of these, and nothing else is claimed: a serializer that
  also escapes quotes, apostrophes, or backticks numerically (.NET's default encoder does)
  produces a form that isn't masked. Matching is greedy and left to right, so when the end of one value
  overlaps the start of another in the output, the second one's remainder can show.
- Every value in the file is masked, not just the ones the command gets: a key set twice, the
  values the file keeps only as comments (the `# stubs skipped`, `# stubs held back`, and
  `# unparsed` lines `pull` leaves behind), and lines the parser can't read (an unclosed
  quote). Dumping the file through `run` shows no value either.
- Values shorter than 6 characters (`true`, `3000`, `dev`) aren't masked: they aren't secrets,
  and blanking them would hit ordinary words all over the output. A longer value that happens
  to be an ordinary word (`development`, `localhost`) is masked wherever it appears, which is
  noise, not a leak.
- The command runs with pipes for stdout and stderr, not a terminal, so tools that check for
  one print without colours or progress bars. On macOS and Linux it also runs in its own
  session and process group, and `stubs run` manages that group: `Ctrl-C`, `SIGTERM`, and
  `SIGHUP` are forwarded to it, and anything in it still running a second later gets
  `SIGKILL`, even a command that ignores the signal. When the command exits, whatever it left
  in the group gets `SIGTERM`, then `SIGKILL` a second later, and the run doesn't return
  until the group is empty. If `stubs` itself crashes, the group is killed on the way out.
  What that doesn't reach: a descendant that starts its own session (`setsid`, Node's
  `detached`, a daemon) has left the group and keeps running with the values. If it also
  kept the output pipes, `run` waits until nothing has moved through them for about a second
  and a half after the command exits, then closes them from its side, says so on stderr, and
  exits with the command's code, or `125` if that was `0`. Output still queued behind a slow
  reader isn't that: the run keeps waiting until it's through, and a short command returns as
  soon as it's done. A detached process that escaped the group and keeps writing will keep
  `run` waiting until it stops. Run never cuts output silently. Tools that open `/dev/tty` for
  a password prompt won't find one. On Windows only the command itself is signalled.
- Nothing is written anywhere: the values exist in the command's environment and in the
  `stubs` process, and go away with them. Messages from `run` never repeat the command, an
  argument, or a file name, since any of those could be a value; they name keys only.

What it doesn't do: it can't mask a value a tool prints transformed in some other way (hex,
reversed, inside a compressed blob, or truncated), and it can't stop a command from writing a
value into a file that gets read later, or from sending it anywhere a process can. See
[What this protects and what it doesn't](#what-this-protects-and-what-it-doesnt).

### `stubs check <link>`

Says whether a stub can still be opened. Never uses it up. Takes `-` for stdin like `pull`.

| Flag | What it does |
|---|---|
| `--origin <url>` | As for `pull`. |
| `--json` | Print one JSON object instead of text. |

```
Sealed. Valid until <local time>.
Void (opened or expired).
```

```
{"ok":true,"status":"sealed","expiresAt":<ms>}
{"ok":true,"status":"void"}
```

### `stubs push [file|--prompt]`

Encrypts a file on your machine and prints a new link. `file` defaults to `.env.local`. Pass
`-` to read stdin. An empty file is refused.

| Flag | What it does |
|---|---|
| `--prompt` | Enter or paste multiline `.env` text with terminal echo disabled. Ctrl-D finishes; Ctrl-C cancels. |
| `--ttl 5m\|1h\|1d\|7d` | How long the link stays valid. Default `1h`. |
| `--to <stubs id>` | Lock the stub to one machine: only the holder of that identity can open it. |
| `--origin <url>` | As for `pull`. |
| `--json` | Print `{"ok":true,"link":"…","expiresAt":<ms>}` (plus `"locked":true` when locked) instead of the bare link. |

An unlocked link is the only way to open the stub, so treat it like the values themselves. A
locked link is safe to leave in a chat: without the recipient's identity it opens nothing.

To create a stub without a plaintext file, run `stubs push --prompt` in your own terminal.
Paste the `.env` text when the hidden-input message appears, then press Ctrl-D. Enter starts
a new line; outside a paste, Backspace removes the last character and Ctrl-U clears the
current line. Input is held in memory and capped at 32 KB of UTF-8. CRLF and Enter become LF.
An empty input is refused. If input exceeds the limit or includes an unsupported control key, the CLI discards
it and keeps echo disabled until the paste ends and you press Ctrl-D or Ctrl-C, so the rest
of a paste stays hidden. The prompt enables bracketed paste in terminals that support it.
Ctrl-C/D inside a bracketed paste reject the input; they do not finish or cancel the prompt.
Press Ctrl-D or Ctrl-C yourself after the paste ends. Pasted editing controls are also refused.
In terminals without bracketed paste, paste plain text without control characters.
Cancellation exits `130` and creates no stub.

`--prompt` requires stdin and stderr to be terminals. It cannot be combined with a file or
`-`. File input and piped stdin keep their existing behavior. The terminal is restored before
encryption and the network request, and bracketed paste is disabled when the prompt ends.
`--json` still prints one result object on stdout; the input instructions go to stderr.

Run this command yourself, then give the agent only the resulting link, preferably locked
with `--to <recipient id>`. Do not paste secrets into an agent chat or ask an agent to launch
the prompt in a terminal it observes. Disabling echo keeps input off ordinary terminal output;
it does not protect against a session recorder that captures input or an agent that observes
the terminal. MCP push and secret elicitation are outside this command's scope.

### `stubs init`

Creates this machine's identity, the same way `ssh-keygen` does: an X25519 key pair in
`~/.config/stubs/identity` (or `$XDG_CONFIG_HOME/stubs/identity`), file mode `0600`, directory
`0700`. Prints your stubs id, a 49-character string starting `stubs1`. Refuses to replace an
existing identity unless you pass `--force`; a new identity can't open stubs locked to the old
one.

Give your stubs id to whoever sends you secrets. They paste it into the "Lock to a recipient"
field on stubs.talix.app, or run `stubs push --to <your id>`. The link they get only opens on
this machine, through `stubs pull`, so it doesn't matter where it ends up.

### `stubs id`

Prints this machine's stubs id, or exits `3` if there's no identity yet.

### `stubs mcp`

Starts an MCP server on stdio, named `stubs`, with two tools:

- `pull_stub`: input `{link, file?, overwrite?}`. Returns the same object as `pull --json`.
- `check_stub`: input `{link}`. Returns the same object as `check --json`.

Both handle locked links with the machine's identity, like the CLI.

There's no push tool. `file` resolves against the server's working directory and must stay
inside its real directory. Absolute paths, paths that climb above it with `..`, and symlinks
to files or parent directories outside it are refused before any network call. This includes
the default `.env.local`. Symlinks within the project work; dangling file symlinks are refused
without replacing them. The same resolved target is used for the git guard, read, and write.
This check doesn't isolate the process from concurrent filesystem changes. Recovery after a
failed write still saves consumed values in the stubs config folder. The CLI's `--to` accepts
user-chosen outside targets. The server reads `STUBS_ORIGIN` from its environment. Failures
come back as tool results with `isError: true` and the error object below.

### `stubs skill install`

Installs the Stubs agent skill: a `SKILL.md` that tells the agent to pull stubs with this exact
CLI version, how to read every exit code, and never to read `.env*` files. It goes to
`~/.claude/skills/stubs/` and `~/.codex/skills/stubs/` (or `$CODEX_HOME/skills/stubs/`), for
each of those tools you have installed.

| Flag | What it does |
|---|---|
| `--target claude\|codex` | Install for one tool only (repeatable). Creates its folders if needed. |
| `--force` | Replace a file at that path that isn't a stubs skill. |
| `--protect` | Also deny Claude Code's file tools reading `.env*` files. See below. |
| `--json` | Print one JSON object instead of text. |

Running it again is safe: it reports "already up to date", or upgrades an older stubs skill in
place. It never touches any other file, and it won't write through a symlinked `stubs` folder or
`SKILL.md` unless you pass `--force`. `stubs skill show` prints the skill instead, for agents
that load instructions some other way.

**`--protect`.** The skill tells the agent not to read `.env*` files. That's an instruction,
and a host setting is better. With `--protect`, the installer adds these to `permissions.deny`
in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`, creating the file if
needed):

```
Read(.env)
Read(.env.*)
Read(~/.config/stubs/**)
```

Claude Code applies a `Read` deny rule to its Read, Edit, and Write tools, to `cat`, `head`,
`tail`, `sed`, and `tee` in Bash, and to shell redirections, at any depth under the project
([permissions](https://code.claude.com/docs/en/permissions#read-and-edit)). It does not apply
to a script that opens the file itself (`node -e`, `python -c`), or to a command that reads
files without naming them (`grep -r`). `.env.example` and `.env.sample` are denied too: a
`Read(!.env.example)` exception would also relax any earlier rule of yours that covers that
name, so the installer adds none. `.envrc` stays readable, which `.env*` would have caught.
The last rule covers the machine identity and recovered values (if `XDG_CONFIG_HOME` is set,
that path is used instead). Everything else in the file is kept, and the rules are appended,
so your own rules still apply; the file is rewritten with two-space indentation. Run it again
and it reports "already deny". To undo it, delete those three lines.

Deny rules are ordered: a `Read(!...)` exception carves paths out of the rules listed before
it. If your file has an exception after one of the stubs rules (`Read(.env.*)` followed by
`Read(!.env.local)`, say), the installer can't tell what it reopens, so it leaves the file
alone (exit `5`) and says which rule and which exception. Move the exception above the stubs
rules, or install without `--protect`. A `settings.json` that isn't valid JSON, or whose
`permissions.deny` isn't a list, is left alone the same way, with the rules printed for you to
add by hand. A symlinked `settings.json` is written through, so a dotfiles setup keeps its
link; a link whose target is missing is refused rather than replaced with a plain file.

Codex has no equivalent setting that the installer can add safely: its file-level deny rules
live in permission profiles (beta), which replace the sandbox configuration rather than adding
to it. `--protect` with `--target codex` reports that and installs nothing. If you use Codex,
see [permissions](https://developers.openai.com/codex/permissions) for a profile that denies
`**/.env*`, and keep the skill, which is the rule the agent follows.

This rule blocks Claude Code's file tools even when you ask it to read a value. That's the
point of a host setting. Open the file yourself, or remove the rule for that session.

The skill pins the CLI version (`@talix/stubs@0.4.0`), so an agent only ever runs a version you
installed on purpose. To move to a newer release, run `skill install` from that release.

## Exit codes

| Code | Meaning | JSON `code` |
|---|---|---|
| 0 | Done | |
| 2 | Void: already opened or expired | `void` |
| 3 | Bad input: malformed link, wrong origin, empty file, unknown flag, a locked link this machine can't open | `invalid` |
| 4 | Network: no response, timeout, or rate limited. Nothing was used; retrying is safe. | `network` |
| 5 | Refused: git would track the file | `refused` |
| 6 | Tampered: opened but wouldn't decrypt. It's void now. | `tampered` |
| 7 | Uncertain: the connection dropped mid-open. Run it again: if it did open, it reports void. | `uncertain` |
| 1 | Anything else | `error` |

With `--json`, a failure prints `{"ok":false,"code":"void","message":"…"}`.

`stubs run` is the exception: its exit code is the command's own, with `125`, `126`, and `127`
reserved as described [above](#stubs-run----cmd-args).

## What it never does

- It never prints a value. No flag does, and no error message includes one. Output names keys
  only.
- It never prints a link it was given. Errors say "the link", not the link itself, and every
  line of output passes a redaction step that blanks anything link-shaped, so a link pasted
  where a file path or a flag was expected can't be echoed back by an error. The one link it
  prints is the new one `push` makes, which is the point of `push`.
- It won't write a file git would track. If the target (symlinks resolved) is in a git work
  tree and isn't ignored, `pull` exits `5` before opening anything and tells you what to add to
  `.gitignore`. If git can't answer but a `.git` directory is above the target, it refuses
  too. `--allow-tracked` overrides this. Outside a repo there's no check.
- It only talks to `https://stubs.talix.app`. A link from any other origin exits `3` without a
  network call, unless you pass `--origin` or set `STUBS_ORIGIN`. So does anything that isn't a
  plain stub link: a query string, credentials, or a character a real link never contains.
- It has no runtime dependencies. Everything it needs is bundled into the package at build
  time, so the version you pin is the whole supply chain: `npx` installs nothing else, and no
  third-party package is loaded into the process that holds the decrypted values.

One limit of `npx` itself: it prefers a package already installed in the project when one
matches the requested name and version. A project whose dependencies you don't trust could
carry a fake `@talix/stubs` under `node_modules`, and `npx -y --loglevel=warn -- @talix/stubs@0.4.0` would run it.
That attacker already runs code in your project, so the extra reach is small, but for untrusted
checkouts install the CLI globally (`npm i -g @talix/stubs@0.4.0`) and run `stubs` from your PATH,
which doesn't look in the project.

## MCP setup

Claude Code:

```bash
claude mcp add stubs -- npx -y @talix/stubs@0.4.0 mcp
```

Cursor, in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "stubs": {
      "command": "npx",
      "args": ["-y", "@talix/stubs@0.4.0", "mcp"]
    }
  }
}
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.stubs]
command = "npx"
args = ["-y", "@talix/stubs@0.4.0", "mcp"]
```

## For your AGENTS.md (if you don't use the skill)

Add this to a project's `AGENTS.md` (or `CLAUDE.md`) so agents know what to do with a link:

```markdown
When given a link on stubs.talix.app, run `npx -y --loglevel=warn -- @talix/stubs@0.4.0 pull <link>` (or the
`pull_stub` tool). It writes the values into `.env.local` and prints only the key names.
Run anything that needs those values as `npx -y --loglevel=warn -- @talix/stubs@0.4.0 run -- <command>`, which
masks them in the output. Never `cat`, read, or print `.env*` files unless the user asks.
```

The CLI keeps values out of its own output. It can't stop an agent from reading the file
afterwards. The last line is the instruction for that, and `stubs skill install --protect`
turns it into a Claude Code permission rule for the file tools Claude Code controls.

## What this protects and what it doesn't

The short version: stubs keeps values out of logs, transcripts, and tool output by accident.
It doesn't stop an agent that sets out to read them. An agent running arbitrary code as you
can read any file you can.

What it protects:

- `pull`, `push`, `check`, `init`, `id`, and the MCP tools never print a value, on any path:
  success, every failure, `--json`, argument errors, and crashes. The link you gave them is
  never echoed either; the only link printed is the new one a successful `push` makes. Tests
  run the built binary with canary values and assert both streams stay clean.
- `run` masks every value from the env file in the command's output, including values split
  across writes with any pause between them and the encodings listed above, so a tool that
  dumps its config on error leaves `[stubs:KEY]` in the transcript, not the secret. Its own
  messages never repeat the command or a file name. There's no flag that turns masking off.
- `run` refuses the loader hooks and config locations listed above, so a stub can't use them
  to run its own code on the machine that pulls it, and refuses a key your environment already
  sets to something else. Its own flag is `--from`, which Node doesn't read, so the file is
  never loaded into `stubs`. The command's process group is stopped when the command exits,
  when `stubs` gets a termination signal, when the reader goes away, and when `stubs`
  crashes, with `SIGKILL` for anything that ignores `SIGTERM`.
- With `--protect`, Claude Code's own file tools and the file commands it recognises in Bash
  refuse `.env*` files and the stubs config folder, whatever the skill says. The installer
  only reports that when the rules are in place and nothing after them carves into them.

What it doesn't:

- Values shorter than 6 characters aren't masked.
- `run` masks what it can recognise. A value printed hex-encoded, in UTF-16, reversed,
  truncated, split between stdout and stderr, inside a compressed blob, or in any other form
  the masker doesn't know gets through. So does a value a command writes into a file that the
  agent reads later.
- `run` masks values from the env file, not the rest of the environment. A secret already in
  your shell's environment is masked only if the file names the same key.
- Masking is a filter on two pipes, not a sandbox. The command has the real values and can
  send them anywhere a normal process can: a file, the network, or the terminal device by its
  name. Running the command in its own session closes `/dev/tty`, not `/dev/ttys003`.
- Cleanup covers the process group `run` starts. A descendant that starts its own session
  escapes it and keeps the values for as long as it runs.
- `--protect` covers Claude Code's file tools and the Bash commands it recognises. A script
  the agent writes (`node -e`, `python -c`), a `grep -r`, or `git show` reads the file anyway;
  see the [Claude Code docs](https://code.claude.com/docs/en/permissions#read-and-edit) for
  the current list. Without `--protect`, or on Codex, nothing stops an agent from reading the
  file except the skill's instructions.
- An agent that decides to see the values can: write a script that reads the file, encode
  them some way the masker doesn't know, or print them somewhere `run` doesn't filter. The
  protections above are for an agent that follows the skill and a toolchain that prints too
  much. Keeping values out of an agent's reach altogether is separate work (TAL-142), not
  something this version claims.

## How it stays private

The CLI runs the same encryption code as the web page: the key stays in the link's fragment,
the server only ever holds ciphertext, and a stub opens once. A locked stub goes one step
further: the link carries the key wrapped to your identity's public key (X25519, HKDF-SHA256,
AES-GCM), so the link alone can't open, check, or burn the stub, and the server never learns
it was locked. The CLI is MIT licensed; the web app and its source live at
[stubs.talix.app](https://stubs.talix.app).
