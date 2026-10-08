// The browser's adapter for the wire contract. Every response is validated with the shared
// parsers, and each operation reports only the failures a caller can actually act on.

import {
  CLIENT_HEADER,
  ROUTES,
  parseApiError,
  parseCreateTicketResponse,
  parseSealedTicket,
  parseTicketStatus,
  type Client,
  type CreateTicketRequest,
  type CreateTicketResponse,
  type SealedTicket,
  type TicketProof,
  type TicketStatus,
} from "../shared/protocol";

/** fetch-shaped. Production passes `fetch`; tests pass the Worker or a fake. */
export type Transport = (path: string, init: RequestInit) => Promise<Response>;

/** Names the CLI or MCP server on every request, for the Worker's usage counts. */
export function withClient(transport: Transport, client: Client): Transport {
  return (path, init) => {
    const headers = new Headers(init.headers);
    headers.set(CLIENT_HEADER, client);
    return transport(path, { ...init, headers });
  };
}

export type Result<T, F extends string> = { ok: true; value: T } | { ok: false; failure: F };

/** "exists": the id is taken (live or recently used). Only possible on a key collision. */
export type CreateFailure = "rate_limited" | "too_large" | "exists" | "network" | "server";
export type StatusFailure = "not_found" | "rate_limited" | "network" | "server";
/**
 * "uncertain": the claim may have reached the server, so the ticket may already be gone.
 * Retrying is safe; it either succeeds or reports not_found.
 */
export type ClaimFailure = "not_found" | "rate_limited" | "uncertain" | "server";

export interface TicketApi {
  create(body: CreateTicketRequest): Promise<Result<CreateTicketResponse, CreateFailure>>;
  status(id: string, proof: TicketProof): Promise<Result<TicketStatus, StatusFailure>>;
  claim(id: string, proof: TicketProof): Promise<Result<SealedTicket, ClaimFailure>>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

type Exchange =
  | { kind: "response"; status: number; body: unknown }
  | { kind: "no_response" };

async function exchange(transport: Transport, path: string, body: unknown, timeoutMs: number) {
  let response: Response;
  try {
    response = await transport(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "no_response" } satisfies Exchange;
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // A body that won't parse is handled like any other unexpected response below.
  }
  return { kind: "response", status: response.status, body: json } satisfies Exchange;
}

function errorCode(reply: Exchange) {
  return reply.kind === "response" ? parseApiError(reply.body) : null;
}

export function createTicketApi(transport: Transport, timeoutMs = DEFAULT_TIMEOUT_MS): TicketApi {
  return {
    async create(body) {
      const reply = await exchange(transport, ROUTES.create, body, timeoutMs);
      if (reply.kind === "no_response") return { ok: false, failure: "network" };
      const created = reply.status === 201 ? parseCreateTicketResponse(reply.body) : null;
      if (created) return { ok: true, value: created };
      const code = errorCode(reply);
      if (code === "rate_limited" || code === "too_large" || code === "exists") {
        return { ok: false, failure: code };
      }
      return { ok: false, failure: "server" };
    },

    async status(id, proof) {
      const reply = await exchange(transport, ROUTES.status(id), proof, timeoutMs);
      if (reply.kind === "no_response") return { ok: false, failure: "network" };
      const status = reply.status === 200 ? parseTicketStatus(reply.body) : null;
      if (status) return { ok: true, value: status };
      const code = errorCode(reply);
      if (code === "not_found" || code === "rate_limited") return { ok: false, failure: code };
      return { ok: false, failure: "server" };
    },

    async claim(id, proof) {
      const reply = await exchange(transport, ROUTES.claim(id), proof, timeoutMs);
      if (reply.kind === "no_response") return { ok: false, failure: "uncertain" };
      if (reply.status === 200) {
        const sealed = parseSealedTicket(reply.body);
        // A 200 means the server already deleted it; an unreadable body loses the contents.
        return sealed ? { ok: true, value: sealed } : { ok: false, failure: "uncertain" };
      }
      const code = errorCode(reply);
      if (code === "not_found" || code === "rate_limited") return { ok: false, failure: code };
      return { ok: false, failure: reply.status >= 500 ? "uncertain" : "server" };
    },
  };
}
