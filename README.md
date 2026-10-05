<img src="assets/icon.svg" width="64" height="64" alt="">

# snapkey

Share `.env` values through a link that opens once. Deploys to
[keyshare.talix.app](https://keyshare.talix.app) (not live yet).

Paste a `.env`, pick how long the link stays valid (5 min, 1 hour, 1 day, 7 days), and print a
ticket. The first person to open the link and tear the ticket gets the values. After that, or at
expiry, the server copy is deleted.

## How it stays private

- The browser generates a random 256-bit key and puts it in the link after the `#`. Browsers
  never send the fragment to a server.
- HKDF-SHA256 derives two things from that key: the storage id and an AES-GCM-256 key. The
  `.env` text is encrypted in the browser, with the id bound in as associated data.
- The Worker only receives the id, ciphertext, IV, and TTL. It can't decrypt, and it doesn't log
  any of them.
- Each secret lives in its own Durable Object. Claiming reads and deletes it inside one input
  gate, so two simultaneous opens can't both succeed. An alarm deletes it at expiry.
- Opening a link only checks status. Revealing takes an explicit click (a POST), so chat link
  previews and unfurlers can't burn a ticket.
- Strict CSP with no third-party origins. Fonts are self-hosted.

## Known limits

- Burn-on-read is single-phase. If the claim response is lost in transit (connection drops at
  that exact moment), the secret is already gone and the recipient has to ask for a new link.
  A grace window would fix that but weaken the one-time guarantee.
- Until a ticket is torn, the full link sits wherever it was sent, and in the recipient's
  browser history (the page strips the `#key` from the address bar on load, but Chrome's
  history keeps the URL as first visited). Anyone with that link can open it first.
- SQLite-backed Durable Objects keep 30 days of point-in-time recovery. Deleted ciphertext is
  recoverable by the Cloudflare account owner in that window, but it's useless without the key,
  which never leaves the browser.
- Rate limits: 30 creates and 120 status/claim calls per IP per minute.

## Layout

| Path | What |
|---|---|
| `src/shared/protocol.ts` | API contract and limits shared by client and Worker |
| `src/worker/` | Worker API (`/api/*`) and the `SecretBox` Durable Object |
| `src/client/` | Vanilla TypeScript UI, crypto, `.env` parser |
| `public/_headers` | CSP and security headers for static assets |
| `test/worker/` | API tests inside workerd (`@cloudflare/vitest-pool-workers`) |
| `test/client/` | Crypto and parser unit tests |

## API

| Method | Path | Result |
|---|---|---|
| `POST` | `/api/secrets` | `{id, ciphertext, iv, ttlSeconds}` → `201 {expiresAt}` |
| `GET` | `/api/secrets/:id` | `200 {expiresAt}` or `404`. Doesn't consume. |
| `POST` | `/api/secrets/:id/claim` | `200 {ciphertext, iv}` once, then `404` |

## Commands

```bash
pnpm install
pnpm dev          # Vite + local workerd on http://localhost:5173
pnpm test         # worker + client tests
pnpm typecheck    # wrangler types, then tsc -b
pnpm build
pnpm deploy       # build, then wrangler deploy to keyshare.talix.app
```

`compatibility_date` is pinned to a date the bundled test runtime supports. Bump it together
with `@cloudflare/vitest-pool-workers`.

Fonts: [Departure Mono](https://departuremono.com) (SIL OFL, license in `src/client/fonts/`) and
Fragment Mono via Fontsource.
