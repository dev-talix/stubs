// Forwards product analytics to PostHog. The browser never talks to PostHog and never sees the
// project key: it posts allowlisted events here, and this module rebuilds each one from the
// schema before adding the key and forwarding. Anything off-schema was already rejected.

import type { AnalyticsBatch } from "../shared/analytics";

export interface AnalyticsConfig {
  /** PostHog ingestion host, e.g. https://us.i.posthog.com */
  host: string;
  /** PostHog project key. When unset (local dev, tests), events are accepted and dropped. */
  key: string | undefined;
}

/** PostHog's /batch/ payload for a validated batch. */
export function toPostHogBatch(batch: AnalyticsBatch, key: string, origin: string, now: Date) {
  return {
    api_key: key,
    batch: batch.events.map(({ event, properties }) => ({
      event: event === "page_viewed" ? "$pageview" : event,
      distinct_id: batch.sessionId,
      timestamp: now.toISOString(),
      properties: {
        ...properties,
        ...(event === "page_viewed" && {
          // Rebuilt from the allowlisted path, so a fragment can never reach PostHog.
          $current_url: `${origin}${properties.path}`,
          $pathname: properties.path,
        }),
        $lib: "stubs",
        // Anonymous, person-less events: no profiles, and no geo from our edge's IP.
        $process_person_profile: false,
        $geoip_disable: true,
      },
    })),
  };
}

/** Sends the batch without delaying the response. Failures are dropped: analytics is best-effort. */
export function forwardToPostHog(
  batch: AnalyticsBatch,
  config: AnalyticsConfig,
  origin: string,
  ctx: Pick<ExecutionContext, "waitUntil">,
) {
  if (!config.key) return;
  const body = JSON.stringify(toPostHogBatch(batch, config.key, origin, new Date()));
  ctx.waitUntil(
    fetch(`${config.host.replace(/\/+$/, "")}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }).then(
      (response) => {
        if (!response.ok) console.error("analytics_forward_failed", response.status);
      },
      (error: unknown) => console.error("analytics_forward_failed", error instanceof Error ? error.name : "Error"),
    ),
  );
}
