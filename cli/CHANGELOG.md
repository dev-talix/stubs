# Changelog

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
