// Usage counts in Workers Analytics Engine: how many stubs get created and opened, and which
// routes fail or get rate limited. Each data point is an event name plus fixed enum values (and
// the expiry, which is one of the offered TTLs). Never an id, link, key, claim secret or hash,
// ciphertext, size, IP, or user agent.

import { CLIENT_HEADER, CLIENTS, type Client, type TtlSeconds } from "../shared/protocol";

export type Source = "web" | Client;
export type RouteName = "create" | "status" | "claim" | "events";

export type UsageEvent =
  | { event: "ticket_created"; source: Source; ttlSeconds: TtlSeconds }
  | { event: "ticket_claimed" | "ticket_claim_unavailable"; source: Source }
  | { event: "worker_error"; route: RouteName | "unknown"; name: string }
  | { event: "rate_limited"; route: RouteName };

/**
 * Who to count a request as, or null when it asked not to be tracked (Global Privacy Control or
 * Do Not Track). Only an exact `cli` or `mcp` header counts as that client; anything else is web.
 */
export function usageSource(headers: Headers): Source | null {
  if (headers.get("Sec-GPC") === "1" || headers.get("DNT") === "1") return null;
  const client = headers.get(CLIENT_HEADER);
  return CLIENTS.find((known) => known === client) ?? "web";
}

function toDataPoint(usage: UsageEvent): AnalyticsEngineDataPoint {
  switch (usage.event) {
    case "ticket_created":
      return { blobs: [usage.event, usage.source], doubles: [usage.ttlSeconds] };
    case "ticket_claimed":
    case "ticket_claim_unavailable":
      return { blobs: [usage.event, usage.source] };
    case "worker_error":
      return { blobs: [usage.event, usage.route, usage.name] };
    case "rate_limited":
      return { blobs: [usage.event, usage.route] };
  }
}

/** Fire and forget. A missing binding or a failed write never touches the response. */
export function countUsage(dataset: AnalyticsEngineDataset | undefined, usage: UsageEvent): void {
  try {
    dataset?.writeDataPoint(toDataPoint(usage));
  } catch {
    // Counting is best-effort.
  }
}
