# @talix/stubs

Pull a one-time [Stubs](https://stubs.talix.app) link straight into a project. `stubs pull`
opens the link, decrypts the values on your machine, and writes them into `.env.local`. It
prints the key names and nothing else, so an agent can run it without the values ever landing
in its context, its transcript, or its logs.

## Install

**For agents, the easiest setup is the skill.** One command installs it for Claude Code and
Codex; from then on, any stubs link you hand the agent gets pulled the safe way:

```bash
npx -y @talix/stubs@0.3.0 skill install
```

Run it without installing:

```bash
npx -y @talix/stubs@0.3.0 pull 'https://stubs.talix.app/t#v1.…'
```

Or install it globally and use the `stubs` bin:

```bash
npm i -g @talix/stubs@0.3.0
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

### `stubs push [file]`

Encrypts a file on your machine and prints a new link. `file` defaults to `.env.local`. Pass
`-` to read stdin. An empty file is refused.

| Flag | What it does |
|---|---|
| `--ttl 5m\|1h\|1d\|7d` | How long the link stays valid. Default `1h`. |
| `--to <stubs id>` | Lock the stub to one machine: only the holder of that identity can open it. |
| `--origin <url>` | As for `pull`. |
| `--json` | Print `{"ok":true,"link":"…","expiresAt":<ms>}` (plus `"locked":true` when locked) instead of the bare link. |

An unlocked link is the only way to open the stub, so treat it like the values themselves. A
locked link is safe to leave in a chat: without the recipient's identity it opens nothing.

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
inside it: an absolute path, or one that climbs above it with `..`, is refused before any
network call. The server reads `STUBS_ORIGIN` from its environment. Failures come back as tool results with
`isError: true` and the error object below.

### `stubs skill install`

Installs the Stubs agent skill: a `SKILL.md` that tells the agent to pull stubs with this exact
CLI version, how to read every exit code, and never to read `.env*` files. It goes to
`~/.claude/skills/stubs/` and `~/.codex/skills/stubs/` (or `$CODEX_HOME/skills/stubs/`), for
each of those tools you have installed.

| Flag | What it does |
|---|---|
| `--target claude\|codex` | Install for one tool only (repeatable). Creates its folders if needed. |
| `--force` | Replace a file at that path that isn't a stubs skill. |
| `--json` | Print one JSON object instead of text. |

Running it again is safe: it reports "already up to date", or upgrades an older stubs skill in
place. It never touches any other file, and it won't write through a symlinked `stubs` folder or
`SKILL.md` unless you pass `--force`. `stubs skill show` prints the skill instead, for agents
that load instructions some other way.

The skill pins the CLI version (`@talix/stubs@0.3.0`), so an agent only ever runs a version you
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

## What it never does

- It never prints a value. No flag does, and no error message includes one. Output names keys
  only.
- It never prints the link either. Errors say "the link", not the link itself, and every line
  of output passes a redaction step that blanks anything link-shaped, so a link pasted where a
  file path or a flag was expected can't be echoed back by an error.
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
carry a fake `@talix/stubs` under `node_modules`, and `npx -y @talix/stubs@0.3.0` would run it.
That attacker already runs code in your project, so the extra reach is small, but for untrusted
checkouts install the CLI globally (`npm i -g @talix/stubs@0.3.0`) and run `stubs` from your PATH,
which doesn't look in the project.

## MCP setup

Claude Code:

```bash
claude mcp add stubs -- npx -y @talix/stubs@0.3.0 mcp
```

Cursor, in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "stubs": {
      "command": "npx",
      "args": ["-y", "@talix/stubs@0.3.0", "mcp"]
    }
  }
}
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.stubs]
command = "npx"
args = ["-y", "@talix/stubs@0.3.0", "mcp"]
```

## For your AGENTS.md (if you don't use the skill)

Add this to a project's `AGENTS.md` (or `CLAUDE.md`) so agents know what to do with a link:

```markdown
When given a link on stubs.talix.app, run `npx -y @talix/stubs@0.3.0 pull <link>` (or the
`pull_stub` tool). It writes the values into `.env.local` and prints only the key names.
Never `cat`, read, or print `.env*` files.
```

The CLI keeps values out of its own output. It can't stop an agent from reading the file
afterwards, which is what the last line is for.

## How it stays private

The CLI runs the same encryption code as the web page: the key stays in the link's fragment,
the server only ever holds ciphertext, and a stub opens once. A locked stub goes one step
further: the link carries the key wrapped to your identity's public key (X25519, HKDF-SHA256,
AES-GCM), so the link alone can't open, check, or burn the stub, and the server never learns
it was locked. The CLI is MIT licensed; the web app and its source live at
[stubs.talix.app](https://stubs.talix.app).
