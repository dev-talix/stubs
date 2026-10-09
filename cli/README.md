<p align="center"><img src="https://stubs.talix.app/og.png" alt="Stubs: share .env values through a link that opens once" width="720"></p>

<p align="center">Share .env values through a link that opens once.</p>

<p align="center">
  <a href="https://stubs.talix.app">Open Stubs</a> ·
  <a href="https://github.com/dev-talix/stubs">Source</a> ·
  <a href="https://stubs.talix.app/security">Security</a>
</p>

`@talix/stubs` pulls a one-time link into `.env.local`, runs commands with those values,
and shares them through new links. It prints key names instead of values and masks
recognised values in command output. This reduces accidental leaks into transcripts
and logs. It doesn't stop an agent that sets out to read your files. The CLI is MIT licensed.

## Install

Needs Node 20 or later. Install the agent skill for Claude Code and Codex:

```bash
npx -y --loglevel=warn -- @talix/stubs@0.5.1 skill install
```

Run the CLI with npx:

```bash
npx -y --loglevel=warn -- @talix/stubs@0.5.1 pull 'https://stubs.talix.app/t#v1.…'
```

Or install it globally and use `stubs`:

```bash
npm i -g @talix/stubs@0.5.1
stubs pull 'https://stubs.talix.app/t#v1.…'
```

Keep `--loglevel=warn --` in npx commands. They prevent npm from echoing arguments
and stop Node from loading an `--env-file` argument before Stubs starts.
For untrusted checkouts, use the global install: npx can run a matching local package.
Unix launchers need `/usr/bin/env -S`; see [runtime requirements](https://github.com/dev-talix/stubs/blob/main/docs/cli-reference.md#runtime-requirements)
for older Unix systems and Windows.

## Commands

### `stubs pull <link>`

Opens the stub once and merges values into `.env.local`, printing key names only.
Existing keys are skipped; use `--overwrite` to replace them or `--to <file>` for another file.

```bash
pbpaste | stubs pull -
```

Reading the link from stdin keeps it out of shell history and the process list.
The target must be ignored by git unless you pass `--allow-tracked`.

### `stubs run -- <cmd> [args...]`

Runs a command with the env file's values and replaces recognised values in stdout
and stderr with `[stubs:KEY]`. Use `--from <file>` to read another file; it can be repeated.

```bash
stubs run -- pnpm test
```

Always put `--` before the command. Conflicting environment values and
[refused keys](https://github.com/dev-talix/stubs/blob/main/docs/cli-reference.md#refused-keys) stop the run.

### `stubs check <link>`

Reports whether the stub is sealed or void without consuming it. Like `pull`, it accepts
`-` for stdin and can open a locked link only with the recipient's identity.

```bash
stubs check 'https://stubs.talix.app/t#v1.…' --json
```

### `stubs push [file|--prompt]`

Encrypts a file and prints a new link; the default file is `.env.local`, and `-` reads stdin.
Use `--ttl 5m|1h|1d|7d` to change the default hour, or `--to <stubs id>` to lock it to a recipient.

```bash
stubs push --prompt --to <recipient-id>
```

Run `--prompt` yourself in a terminal. Paste multiline text, then press Ctrl-D; Ctrl-C
cancels. It hides input but can't protect against input recording or an agent observing
the terminal. Give the agent only the link. An unlocked link is as sensitive as its values.

### `stubs init`

Creates an X25519 identity in the stubs config folder and prints a `stubs1` id to share
with senders. `--force` replaces an existing identity, which loses access to its locked stubs.

```bash
stubs init
```

### `stubs id`

Prints this machine's stubs id. Exits `3` if no identity exists yet.

```bash
stubs id
```

### `stubs mcp`

Starts a stdio MCP server with `pull_stub` and `check_stub`, including locked-link support.
Pull targets must stay inside the server's working directory; there is no push tool.

```bash
stubs mcp
```

### `stubs skill install`

Installs or updates the agent skill for Claude Code and Codex with the current CLI version
pinned. `--protect` also adds Claude Code file deny rules; Codex gets the skill but no deny rule.

```bash
stubs skill install --target claude --protect
```

### `stubs skill show`

Prints the skill for agents that load instructions another way.

```bash
stubs skill show
```

See the [CLI reference](https://github.com/dev-talix/stubs/blob/main/docs/cli-reference.md)
for all flags, JSON results, file recovery, masking, process cleanup, and permission rules.

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
| 130 | Cancelled hidden input during `push --prompt`, including Ctrl-C | `invalid` |
| 1 | Anything else | `error` |

With `--json`, a failure prints `{"ok":false,"code":"void","message":"…"}`.
Cancelling `push --prompt` reports `code: "invalid"` and `exitCode: 130` in JSON.
That optional `exitCode` field overrides the usual exit code for the failure.

`stubs run` is the exception: its exit code is the command's own, with `125`, `126`, and `127`
reserved for a Stubs failure, a non-executable command, and a missing command.
Signals return `128 + signal`; a closed output reader returns `141`. Other output failures
return `1`. See [process behavior](https://github.com/dev-talix/stubs/blob/main/docs/cli-reference.md#process-behavior).

## What this protects and what it doesn't

The CLI keeps values out of its own messages and masks recognised env-file values in
`run` output. The server stores ciphertext; keys stay in link fragments, and locked links
require the recipient's identity. See the [security model](https://github.com/dev-talix/stubs/blob/main/docs/security-model.md).

Values shorter than 6 characters, unsupported encodings, and secrets only in the shell's
environment aren't masked. Commands can write files, send network requests, or escape
process-group cleanup. Claude Code's `--protect` rules don't stop scripts from reading
files. These tools don't isolate secrets from an agent running arbitrary code as you.
Read the [full protection limits](https://github.com/dev-talix/stubs/blob/main/docs/cli-reference.md#what-this-protects-and-what-it-doesnt).

## MCP setup

Claude Code:

```bash
claude mcp add stubs -- npx -y @talix/stubs@0.5.1 mcp
```

Cursor, in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "stubs": {
      "command": "npx",
      "args": ["-y", "@talix/stubs@0.5.1", "mcp"]
    }
  }
}
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.stubs]
command = "npx"
args = ["-y", "@talix/stubs@0.5.1", "mcp"]
```

## Without the skill

Add this to a project's `AGENTS.md` (or `CLAUDE.md`) so agents know what to do with a link:

```markdown
When given a link on stubs.talix.app, run `npx -y --loglevel=warn -- @talix/stubs@0.5.1 pull <link>` (or the
`pull_stub` tool). It writes the values into `.env.local` and prints only the key names.
Run anything that needs those values as `npx -y --loglevel=warn -- @talix/stubs@0.5.1 run -- <command>`, which
masks them in the output. Never `cat`, read, or print `.env*` files unless the user asks.
```
