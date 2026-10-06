// Product analytics: page views and generated stubs, nothing else. Events go to this app's own
// /api/events, which re-checks them against the same allowlist before forwarding to PostHog.
// Nothing typed or pasted into the page is ever read here.

import { EVENTS_ROUTE, type AnalyticsEvent } from "../shared/analytics";

// Random per page load and kept only in memory: no cookies, no storage, no cross-visit identity.
const sessionId = crypto.randomUUID();

function optedOut(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1";
}

/** Fire and forget. Never blocks the page, never throws, never retries. */
export function track(event: AnalyticsEvent) {
  if (optedOut()) return;
  fetch(EVENTS_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, events: [event] }),
    cache: "no-store",
    keepalive: true,
  }).catch(() => {});
}
