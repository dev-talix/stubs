// Product analytics contract. The browser sends only these events, with only these properties,
// to the app's own /api/events route; the Worker re-validates against the same schema and drops
// anything else before forwarding to PostHog. Nothing here may ever carry a ticket key, link,
// id, claim secret, ciphertext, or any .env content.

import { TTL_SECONDS } from "./protocol";

export const EVENTS_ROUTE = "/api/events";

/** Pages that can be reported, by path only. Never a fragment or query string. */
export const TRACKED_PATHS = ["/", "/t"] as const;

type OneOf<T extends readonly unknown[]> = T[number];

/**
 * The only two things measured: someone opened a page, and someone generated a stub. Nothing
 * about what was pasted (not even how many items) is ever part of an event.
 */
export type AnalyticsEvent =
  | { event: "page_viewed"; properties: { path: OneOf<typeof TRACKED_PATHS> } }
  | { event: "stub_generated"; properties: { ttl_seconds: OneOf<typeof TTL_SECONDS> } };

export interface AnalyticsBatch {
  /** Random per page load. Not a person, not stored anywhere in the browser. */
  sessionId: string;
  events: AnalyticsEvent[];
}

export const MAX_EVENTS_PER_BATCH = 20;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Fields = Record<string, unknown>;
type Check = (value: unknown) => boolean;

const oneOf =
  (options: readonly unknown[]): Check =>
  (value) =>
    options.includes(value);

const SCHEMA: Record<AnalyticsEvent["event"], Record<string, Check>> = {
  page_viewed: { path: oneOf(TRACKED_PATHS) },
  stub_generated: { ttl_seconds: oneOf(TTL_SECONDS) },
};

const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Accepts an event only if its name is known and its properties match exactly. */
export function parseAnalyticsEvent(value: unknown): AnalyticsEvent | null {
  if (!isObject(value) || typeof value.event !== "string" || !Object.hasOwn(SCHEMA, value.event)) {
    return null;
  }
  const checks = SCHEMA[value.event as AnalyticsEvent["event"]];
  const properties = value.properties ?? {};
  if (!isObject(properties)) return null;
  const keys = Object.keys(properties);
  if (keys.length !== Object.keys(checks).length) return null;
  for (const key of keys) {
    const check = Object.hasOwn(checks, key) ? checks[key] : undefined;
    if (!check || !check(properties[key])) return null;
  }
  return { event: value.event, properties } as AnalyticsEvent;
}

/** Whole batch or nothing: one bad event means the client is out of contract. */
export function parseAnalyticsBatch(value: unknown): AnalyticsBatch | null {
  if (!isObject(value) || typeof value.sessionId !== "string" || !SESSION_ID_PATTERN.test(value.sessionId)) {
    return null;
  }
  if (!Array.isArray(value.events) || value.events.length === 0 || value.events.length > MAX_EVENTS_PER_BATCH) {
    return null;
  }
  const events: AnalyticsEvent[] = [];
  for (const raw of value.events) {
    const event = parseAnalyticsEvent(raw);
    if (!event) return null;
    events.push(event);
  }
  return { sessionId: value.sessionId, events };
}
