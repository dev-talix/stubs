# Development

[Back to Stubs](../README.md)

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

## Local commands

```bash
pnpm install
pnpm dev          # Vite + local workerd on http://localhost:5173
pnpm test         # worker, client, core, shared, and CLI tests
pnpm typecheck    # wrangler types, then tsc -b
pnpm build
pnpm --filter @talix/stubs build   # CLI bundle into cli/dist/
pnpm run deploy   # build, then wrangler deploy (plain `pnpm deploy` is pnpm's own command)
```

## Releases

The CLI version shown everywhere comes from `cli/package.json`: the site reads it at build
time, and `pnpm sync-version` rewrites the literal pins in the markdown and both versions in
`cli/server.json`. To release, bump the
version there, run `pnpm sync-version`, add a CHANGELOG entry, publish from `cli/`, then
deploy. `test/shared/pinned-version.test.ts` fails if anything still points at an old version.

`compatibility_date` is pinned to a date the bundled test runtime supports. Bump it together
with `@cloudflare/vitest-pool-workers`.

## Fonts

[Departure Mono](https://departuremono.com) uses SIL OFL, with its license in `src/client/fonts/`. The app also uses
Fragment Mono via Fontsource.
