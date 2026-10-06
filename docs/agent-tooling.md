# Agent tooling: `@talix/stubs`

Spec for the CLI, the MCP server, the agent docs, and machine-bound stubs. Implementation
traces to the numbered requirements here.

## Goal

An agent handed a stubs link moves the values into the project without ever seeing them. The
values never enter the agent's context, its transcript, its logs, or any tool output.

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
  project's env file. Returns key names only. Never read or print the env file afterwards."
- `check_stub` — input `{link: string}`; output is the R2 JSON object.

No `push` tool. File paths resolve against the server's working directory. The server inherits
`STUBS_ORIGIN`. Tool errors are returned as MCP tool results with `isError: true` and the R1
error object, never thrown.

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

## Agent docs (R7)

- `cli/README.md`: install, the four commands, exit codes, the no-leak guarantee, MCP setup
  for Claude Code (`claude mcp add stubs -- npx -y @talix/stubs@0.2.0 mcp`), Cursor
  (`.cursor/mcp.json`), and Codex (`~/.codex/config.toml` `[mcp_servers.stubs]`).
- The root `README.md` gets a short "For agents" section linking there, plus this `AGENTS.md`
  snippet:

  > When given a link on stubs.talix.app, run `npx -y @talix/stubs@0.2.0 pull <link>` (or the
  > `pull_stub` tool). It writes the values into `.env.local` and prints only the key names.
  > Never `cat`, read, or print `.env*` files.

- The opened-ticket page in the web app (`src/client/reveal.ts`) and the sealed page get one
  line of fine print: "Pulling this into a project? `npx -y @talix/stubs@0.2.0 pull <link>` writes it
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
  `npx -y @talix/stubs@0.2.0 pull <link>` command with a copy button and explains why the browser
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
Windows ACLs beyond what `fs.chmod` gives, self-hosting docs.
