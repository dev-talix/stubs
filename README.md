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
- Strict CSP with no third-party origins. Fonts are self-hosted. This also blocks anything the
  edge injects into pages (such as Cloudflare's Web Analytics beacon), which could otherwise
  read the URL while the key is still in it.

## Analytics

Two events go to PostHog: a page was viewed (`/` or `/t`, path only) and a stub was generated
(with its expiry). Nothing typed or pasted is read, there's no session replay or click capture,
and visitors with Global Privacy Control or Do Not Track send nothing.

- The browser posts to this app's own `/api/events`, never to PostHog, so the CSP stays
  same-origin.
- The Worker checks each event against the allowlist in `src/shared/analytics.ts`, rebuilds it,
  and adds the PostHog project key, which lives only as a Worker secret
  (`wrangler secret put POSTHOG_KEY`). Without the secret, events are accepted and dropped.
- Each page load gets a random id held in memory: no cookies, no storage, no person profiles.

## Known limits

- Burn-on-read is single-phase. If the claim response is lost in transit (connection drops at
  that exact moment), the secret is already gone and the recipient has to ask for a new link.
  The page says so rather than guessing. A grace window would fix it but weaken the one-time
  guarantee.
- Until a ticket is torn, the full link sits wherever it was sent, and in the recipient's
  browser history (Chrome's history keeps the URL as first visited). Anyone with that link can
  open it first.
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
| `src/client/ticket.ts` | The Ticket module: issue, inspect, reveal. Owns keys and their order of use |
| `src/client/ticket-session.ts` | Key custody in the recipient's tab |
| `src/client/create-flow.ts` | Ticket creation as a state machine |
| `src/client/` (rest) | Views, receipt screen, crypto, wire adapter, `.env` parser |
| `public/_headers` | CSP and security headers for static assets |
| `test/worker/` | API and end-to-end tests inside workerd (`@cloudflare/vitest-pool-workers`) |
| `test/client/`, `test/shared/` | Client and contract tests |

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
pnpm deploy       # build, then wrangler deploy to stubs.talix.app
```

`compatibility_date` is pinned to a date the bundled test runtime supports. Bump it together
with `@cloudflare/vitest-pool-workers`.

Fonts: [Departure Mono](https://departuremono.com) (SIL OFL, license in `src/client/fonts/`) and
Fragment Mono via Fontsource.
