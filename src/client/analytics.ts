// Product analytics: page views, nothing else. Events go to this app's own
// /api/events, which re-checks them against the same allowlist before forwarding to PostHog.
// Nothing typed or pasted into the page is ever read here.

import {
  EVENTS_ROUTE,
  SESSION_MAX_AGE_MS,
  UTM_KEYS,
  isReferringDomain,
  isUtmValue,
  type Acquisition,
  type AnalyticsEvent,
} from "../shared/analytics";

/** A random UUIDv7: 48 bits of milliseconds, then random bits under the version and variant. */
export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Random per page load and kept only in memory: no cookies, no storage, no cross-visit identity.
// A tab open past PostHog's 24-hour session limit starts a fresh id.
let sessionStartedAt = Date.now();
let sessionId = uuidv7(sessionStartedAt);

/**
 * The referring site's hostname (skipped when it's this site) and any well-formed campaign tags.
 * A value that's off-contract is left out, so the page view itself still counts.
 */
export function readAcquisition(referrer: string, search: string, origin: string): Acquisition {
  const acquisition: Acquisition = {};
  try {
    const from = new URL(referrer);
    const domain = from.hostname.toLowerCase();
    if (from.origin !== origin && isReferringDomain(domain)) acquisition.referring_domain = domain;
  } catch {
    // No referrer (direct visit, or the referring page withheld it).
  }
  const params = new URLSearchParams(search);
  for (const key of UTM_KEYS) {
    const value = params.get(key)?.toLowerCase();
    if (isUtmValue(value)) acquisition[key] = value;
  }
  return acquisition;
}

function optedOut(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1";
}

/** Fire and forget. Never blocks the page, never throws, never retries. */
export function track(event: AnalyticsEvent) {
  if (optedOut()) return;
  if (Date.now() - sessionStartedAt >= SESSION_MAX_AGE_MS) {
    sessionStartedAt = Date.now();
    sessionId = uuidv7(sessionStartedAt);
  }
  fetch(EVENTS_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, events: [event] }),
    cache: "no-store",
    keepalive: true,
  }).catch(() => {});
}
