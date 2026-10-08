<img src="assets/icon.svg" width="64" height="64" alt="">

# Stubs

Share `.env` values through a link that opens once. Live at
[stubs.talix.app](https://stubs.talix.app).

Paste a `.env`, pick how long the link stays valid (5 min, 1 hour, 1 day, 7 days), and print a
ticket. The first person to open the link and tear the ticket gets the values. After that, or at
expiry, the server copy is deleted.

## How it stays private

- The browser generates a random 256-bit key and puts it in the link after the `#`
  (`/t#v1.<key>`). Browsers never send the fragment to a server.
- HKDF-SHA256 derives three things from that key: the storage id, an AES-GCM-256 key, and a
  claim secret. The `.env` text is encrypted in the browser, with the id bound in as associated
  data.
- The Worker receives the id, a SHA-256 hash of the claim secret, the ciphertext, IV, and TTL.
  It can't decrypt, and it never logs any of them.
- Checking or opening a ticket requires the claim secret, which only the link can derive. An id
  (it appears in request logs) can't read, check, or burn a ticket: a wrong proof looks exactly
  like a missing ticket and leaves the ticket untouched. The most an id reveals is that a ticket
  with it was created and hasn't reached its expiry yet, because creating another ticket under
  that id is refused. That refusal is also what guarantees every link is unique.
- Links can't be guessed: each one carries a fresh 256-bit key from the browser's CSPRNG
  (`crypto.getRandomValues`), and every guess has to go through the rate-limited server.
- Each ticket lives in its own Durable Object. Claiming checks the proof, then reads and deletes
  inside one input gate, so two simultaneous opens can't both succeed. A consumed id stays
  blocked until its original expiry, and an alarm deletes everything at expiry.
- Opening a link only checks status. Revealing takes an explicit click, so chat link previews and
  unfurlers can't burn a ticket. Cross-site requests are refused, so another website can't make
  a visitor's browser burn one either.
- The page takes the key out of the address bar as soon as it loads. Once a ticket is opened or
  found void, the tab forgets it: refreshing, going back, or reopening the tab lands on the
  create page, and the opened page is blanked before the browser can cache it.
- A stub can be locked to a recipient's machine. The link then carries the ticket key wrapped
  to their X25519 public key (ephemeral ECDH, HKDF-SHA256, AES-GCM); only `stubs pull` on that
  machine can unwrap it. The server sees no difference, and the link alone can't open, check,
  or burn the stub.
- Strict CSP with no third-party origins. Fonts are self-hosted. Every response is also marked
  `Cache-Control: no-transform`, so the edge doesn't inject scripts (such as Cloudflare's Web
  Analytics beacon) that could read the URL while the key is still in it; the CSP would block
  them anyway.

## Analytics

The browser sends one event to PostHog: a page was viewed (`/` or `/t`, path only). Nothing
typed or pasted is read, there's no session replay or click capture, and visitors with Global
Privacy Control or Do Not Track send nothing.
Page views on `/` also carry the referring site's domain (never its path) and any campaign tags,
but `/t` never does.

- The browser posts to this app's own `/api/events`, never to PostHog, so the CSP stays
  same-origin.
- The Worker checks each event against the allowlist in `src/shared/analytics.ts`, rebuilds it,
  and adds the PostHog project key, which lives only as a Worker secret
  (`wrangler secret put POSTHOG_KEY`). Without the secret, events are accepted and dropped.
- Each page load gets a random id held in memory, which PostHog also uses as the session id: no
  cookies, no storage, no person profiles.

The Worker also counts usage in Workers Analytics Engine (dataset `stubs_usage`). It counts
stubs created (with the expiry), claims that opened a stub, and claims that found nothing, each
by client: `web`, `cli` or `mcp`. The CLI and MCP server name themselves in an
`X-Stubs-Client` header. Creates and claims sent with `Sec-GPC: 1` or `DNT: 1` aren't counted.

It also counts Worker errors and rate-limited requests, and those are counted even with
`Sec-GPC: 1` or `DNT: 1`. They carry no user data: an error is the event name, the route
(`create`, `status`, `claim`, `events` or `unknown`) and the error name (like `TypeError`). A
rate limit is the event name and the route. Neither records the client.

No data point carries an id, link, key, claim secret, ciphertext, size, IP or user agent. See
`src/worker/usage.ts`.

## For agents

An agent handed a stubs link can move the values into a project, use them, and pass them on
without the values landing in its transcript. [`@talix/stubs`](cli/README.md) has three
commands for that:
`pull` opens the link, writes the values into `.env.local`, and prints only the key names;
`run -- <cmd>` runs tests, dev servers, and scripts with those values and replaces every one of
them in the output with `[stubs:KEY]`; `push` seals the file into a new link without printing
it. It runs as a CLI or as an MCP server for Claude Code, Cursor, and Codex.
A stub can also be locked to one machine: the recipient runs `npx -y --loglevel=warn -- @talix/stubs@0.3.0 init` once
and shares the id it prints; the sender pastes it into "Lock to a recipient". A locked link is
useless without that machine's identity, so it's safe to leave in a chat with an agent.
The simplest setup is the agent skill, which works across every project:

```bash
npx -y --loglevel=warn -- @talix/stubs@0.3.0 skill install
```

Add `--protect` to also give Claude Code a permission rule that denies its file tools reading
`.env*` files, so a `cat .env.local` is refused even if the agent ignores the skill. Or add
this to a project's `AGENTS.md`:

```markdown
When given a link on stubs.talix.app, run `npx -y --loglevel=warn -- @talix/stubs@0.3.0 pull <link>` (or the
`pull_stub` tool). It writes the values into `.env.local` and prints only the key names.
Run anything that needs those values as `npx -y --loglevel=warn -- @talix/stubs@0.3.0 run -- <command>`, which
masks them in the output. Never `cat`, read, or print `.env*` files unless the user asks.
```

Commands, exit codes, and MCP setup are in [cli/README.md](cli/README.md).

### What this protects and what it doesn't

This keeps values out of logs and transcripts by accident. The CLI never prints a value on any
path, prints a link only when `push` makes one, and `run` masks the file's values in whatever the command prints, in the
plain, JSON-escaped, URL-encoded, and base64 forms. With `--protect`, Claude Code's file tools
refuse to open the file.

It doesn't stop an agent that sets out to read the values. An agent running arbitrary code as
you can read any file you can: a `node -e` script isn't covered by the permission rule, a
value printed in hex or UTF-16 gets past the masker, and a command can write to the terminal
device by name. Values shorter than 6 characters aren't masked at all. Keeping values out of
an agent's reach altogether is separate, planned work (TAL-142); this version doesn't claim
it. The full list is in [cli/README.md](cli/README.md#what-this-protects-and-what-it-doesnt).

## Known limits

- Burn-on-read is single-phase. If the claim response is lost in transit (connection drops at
  that exact moment), the secret is already gone and the recipient has to ask for a new link.
  The page says so rather than guessing. A grace window would fix it but weaken the one-time
  guarantee.
- Until an unlocked ticket is torn, the full link sits wherever it was sent, and in the
  recipient's browser history (Chrome's history keeps the URL as first visited). Anyone with
  that link can open it first. Locking a stub to the recipient removes this.
- An unopened ticket is kept in the tab's session storage so a refresh before tearing works.
  Browsers can write session storage to disk for session restore. It's removed the moment the
  ticket is opened or found void.
- SQLite-backed Durable Objects keep 30 days of point-in-time recovery. Deleted ciphertext is
  recoverable by the Cloudflare account owner in that window, but it's useless without the key,
  which never leaves the browser.
- Rate limits: 30 creates and 120 status/claim calls per client per minute, per Cloudflare
  location. IPv6 clients are counted per /64.

## Layout

| Path | What |
|---|---|
| `src/shared/protocol.ts` | Wire contract: routes, payloads, runtime validation, error codes, format sizes |
| `src/worker/` | Worker API (`/api/*`) and the `SecretBox` Durable Object |
| `src/core/` | Runtime-agnostic: the Ticket module (issue, inspect, reveal), crypto, wire adapter, `.env` parser. Used by the browser, the CLI, and the tests |
| `src/client/ticket-session.ts` | Key custody in the recipient's tab |
| `src/client/create-flow.ts` | Ticket creation as a state machine |
| `src/client/` | Browser views, receipt screen, key custody, creation state |
| `cli/` | `@talix/stubs`: CLI and MCP server for pulling stubs into a project |
| `public/_headers` | CSP and security headers for static assets |
| `security.html`, `public/.well-known/security.txt` | The static `/security` page (no script) and the RFC 9116 contact file |
| `cli/server.json` | MCP Registry entry for `@talix/stubs` (`mcpName` in `cli/package.json` must match its `name`) |
| `src/llms.txt`, `scripts/sync-version.mjs` | Agent page template and the version sync for markdown docs and `cli/server.json` |
| `test/worker/` | API and end-to-end tests inside workerd (`@cloudflare/vitest-pool-workers`) |
| `test/client/`, `test/core/`, `test/shared/` | Client, core, and contract tests |

## API

Every route is a JSON `POST`.

| Path | Body | Result |
|---|---|---|
| `/api/tickets` | `{id, claimHash, ciphertext, iv, ttlSeconds}` | `201 {expiresAt}`, or `409` if the id is in use |
| `/api/tickets/:id/status` | `{claimSecret}` | `200 {expiresAt}` or `404`. Doesn't consume. |
| `/api/tickets/:id/claim` | `{claimSecret}` | `200 {ciphertext, iv}` once, then `404` |

Errors are `{error: code}` with codes listed in `API_ERRORS` in `src/shared/protocol.ts`.

## Commands

```bash
pnpm install
pnpm dev          # Vite + local workerd on http://localhost:5173
pnpm test         # worker + client tests
pnpm typecheck    # wrangler types, then tsc -b
pnpm build
pnpm --filter @talix/stubs build   # CLI bundle into cli/dist/
pnpm run deploy   # build, then wrangler deploy (plain `pnpm deploy` is pnpm's own command)
```

The CLI version shown everywhere comes from `cli/package.json`: the site reads it at build
time, and `pnpm sync-version` rewrites the literal pins in the markdown and both versions in
`cli/server.json`. To release, bump the
version there, run `pnpm sync-version`, add a CHANGELOG entry, publish from `cli/`, then
deploy. `test/shared/pinned-version.test.ts` fails if anything still points at an old version.

`compatibility_date` is pinned to a date the bundled test runtime supports. Bump it together
with `@cloudflare/vitest-pool-workers`.

Fonts: [Departure Mono](https://departuremono.com) (SIL OFL, license in `src/client/fonts/`) and
Fragment Mono via Fontsource.
