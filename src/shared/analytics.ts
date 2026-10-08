// Product analytics contract. The browser sends only these events, with only these properties,
// to the app's own /api/events route; the Worker re-validates against the same schema and drops
// anything else before forwarding to PostHog. Nothing here may ever carry a ticket key, link,
// id, claim secret, ciphertext, or any .env content.

export const EVENTS_ROUTE = "/api/events";

/** Pages that can be reported, by path only. Never a fragment or query string. */
export const TRACKED_PATHS = ["/", "/t"] as const;

/** Campaign tags read from the landing URL. No other query parameter is ever read. */
export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign"] as const;

type OneOf<T extends readonly unknown[]> = T[number];

/**
 * Where a visit to `/` came from: the referring site's hostname (never its path or query) and
 * any campaign tags. Never sent for `/t`, whose link carries the ticket key.
 */
export type Acquisition = { referring_domain?: string } & { [K in OneOf<typeof UTM_KEYS>]?: string };

/**
 * The only thing the browser measures: someone opened a page. The Worker counts created stubs
 * itself (src/worker/usage.ts). Nothing about what was pasted is ever part of an event.
 */
export type AnalyticsEvent =
  | { event: "page_viewed"; properties: { path: OneOf<typeof TRACKED_PATHS> } & Acquisition };

export interface AnalyticsBatch {
  /** Random UUIDv7 per page load. Not a person, not stored anywhere in the browser. */
  sessionId: string;
  events: AnalyticsEvent[];
}

export const MAX_EVENTS_PER_BATCH = 20;
/** PostHog drops a UUIDv7 $session_id from session grouping once it's 24 hours past its timestamp. */
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// PostHog only groups events into sessions by a UUIDv7 $session_id. Version 4 is still accepted
// (and forwarded without $session_id) for tabs opened before the v7 client shipped. Transition
// only: drop the 4 once that client has been live for a week.
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Lowercase dotted labels, as URL.hostname gives them. No port, path, or IPv6 brackets. At least
// two labels, and the last one starts with a letter, so IP addresses and bare intranet names fail.
const HOSTNAME_PATTERN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z][a-z0-9-]{0,62}$/;
const UTM_VALUE_PATTERN = /^[a-z0-9_-]{1,40}$/;

type Fields = Record<string, unknown>;
type Check = (value: unknown) => boolean;

const oneOf =
  (options: readonly unknown[]): Check =>
  (value) =>
    options.includes(value);

const matches =
  (pattern: RegExp) =>
  (value: unknown): value is string =>
    typeof value === "string" && pattern.test(value);

export const isReferringDomain = matches(HOSTNAME_PATTERN);
export const isUtmValue = matches(UTM_VALUE_PATTERN);

interface EventSchema {
  required: Record<string, Check>;
  /** Each may be left out, and none is allowed at all unless `when` holds for the event. */
  optional?: { checks: Record<string, Check>; when: (properties: Fields) => boolean };
}

const SCHEMA: Record<AnalyticsEvent["event"], EventSchema> = {
  page_viewed: {
    required: { path: oneOf(TRACKED_PATHS) },
    optional: {
      checks: { referring_domain: isReferringDomain, ...Object.fromEntries(UTM_KEYS.map((key) => [key, isUtmValue])) },
      when: (properties) => properties.path === "/",
    },
  },
};

const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Accepts an event only if its name is known, every required property is there, and every
 * property it has is allowed (optional ones only where the schema allows them) and valid.
 */
export function parseAnalyticsEvent(value: unknown): AnalyticsEvent | null {
  if (!isObject(value) || typeof value.event !== "string" || !Object.hasOwn(SCHEMA, value.event)) {
    return null;
  }
  const { required, optional } = SCHEMA[value.event as AnalyticsEvent["event"]];
  const properties = value.properties ?? {};
  if (!isObject(properties)) return null;
  if (!Object.keys(required).every((key) => Object.hasOwn(properties, key))) return null;
  const allowed = optional?.when(properties) ? { ...optional.checks, ...required } : required;
  for (const key of Object.keys(properties)) {
    const check = Object.hasOwn(allowed, key) ? allowed[key] : undefined;
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
