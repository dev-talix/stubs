// Forwards product analytics to PostHog. The browser never talks to PostHog and never sees the
// project key: it posts allowlisted events here, and this module rebuilds each one from the
// schema before adding the key and forwarding. Anything off-schema was already rejected.

import { SESSION_MAX_AGE_MS, type AnalyticsBatch, type AnalyticsEvent } from "../shared/analytics";

type PageView = Extract<AnalyticsEvent, { event: "page_viewed" }>;

export interface AnalyticsConfig {
  /** PostHog ingestion host, e.g. https://us.i.posthog.com */
  host: string;
  /** PostHog project key. When unset (local dev, tests), events are accepted and dropped. */
  key: string | undefined;
}

/** PostHog's /batch/ payload for a validated batch. */
export function toPostHogBatch(batch: AnalyticsBatch, key: string, origin: string, now: Date) {
  const session = usableSessionId(batch.sessionId, now.getTime());
  return {
    api_key: key,
    batch: batch.events.map(({ event, properties }) => ({
      event: event === "page_viewed" ? "$pageview" : event,
      distinct_id: batch.sessionId,
      timestamp: now.toISOString(),
      properties: {
        ...(event === "page_viewed" ? pageViewProperties(properties, origin) : properties),
        // One page load is one session, under the same id, when PostHog will accept it as one.
        ...(session && { $session_id: session }),
        $lib: "stubs",
        // Anonymous, person-less events: no profiles, and no geo from our edge's IP.
        $process_person_profile: false,
        $geoip_disable: true,
      },
    })),
  };
}

/**
 * The id, if PostHog can group a session by it at `now`: a UUIDv7 whose timestamp isn't after
 * `now` and is less than 24 hours before it. Otherwise (a skewed browser clock, a tab left open
 * for days, or a pre-v7 tab's v4 id) the event still goes, just without a session.
 */
function usableSessionId(id: string, now: number): string | undefined {
  if (id[14] !== "7") return undefined;
  const startedAt = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  return startedAt <= now && now - startedAt < SESSION_MAX_AGE_MS ? id : undefined;
}

function pageViewProperties({ referring_domain, ...properties }: PageView["properties"], origin: string) {
  return {
    ...properties,
    // Rebuilt from the allowlisted path, so a fragment or query string can never reach PostHog.
    $current_url: `${origin}${properties.path}`,
    $pathname: properties.path,
    ...(referring_domain && { $referring_domain: referring_domain }),
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
