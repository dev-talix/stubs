# Security model

[Back to Stubs](../README.md)

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

## Agent access

The CLI reduces accidental disclosure in logs and transcripts. It does not stop an agent
that can run arbitrary code as you from reading your files. See the
[CLI protection limits](cli-reference.md#what-this-protects-and-what-it-doesnt).
