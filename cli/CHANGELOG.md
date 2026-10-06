# Changelog

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
