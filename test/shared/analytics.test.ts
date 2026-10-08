import { describe, expect, it } from "vitest";
import { MAX_EVENTS_PER_BATCH, parseAnalyticsBatch } from "../../src/shared/analytics";

const SESSION = "01890a5d-ac96-774b-bcce-b302099a8057";
const view = { event: "page_viewed", properties: { path: "/t" } };
const home = { event: "page_viewed", properties: { path: "/" } };
const landing = (extra: Record<string, unknown>) => ({ event: "page_viewed", properties: { path: "/", ...extra } });
const batch = (...events: unknown[]) => ({ sessionId: SESSION, events });

describe("parseAnalyticsBatch", () => {
  it("accepts page views on the tracked paths", () => {
    expect(parseAnalyticsBatch(batch(view, home))).toEqual({ sessionId: SESSION, events: [view, home] });
  });

  it("still accepts a UUIDv4 session from a tab opened before the v7 client shipped", () => {
    const legacy = { sessionId: "123e4567-e89b-42d3-a456-426614174000", events: [view] };
    expect(parseAnalyticsBatch(legacy)).toEqual(legacy);
  });

  it("accepts a referring domain and campaign tags on /, each optional", () => {
    const full = landing({
      referring_domain: "news.ycombinator.com",
      utm_source: "hn",
      utm_medium: "social",
      utm_campaign: "launch_2026-10",
    });
    const partial = landing({ utm_source: "x" });
    expect(parseAnalyticsBatch(batch(full, partial))).toEqual({ sessionId: SESSION, events: [full, partial] });
  });

  it.each([
    ["an unknown event", { event: "stub_opened", properties: {} }],
    ["an inherited name", { event: "constructor", properties: {} }],
    ["a path with a fragment", { event: "page_viewed", properties: { path: "/t#v1.abc" } }],
    ["a path with a query", { event: "page_viewed", properties: { path: "/?x=1" } }],
    ["an extra property", { event: "page_viewed", properties: { path: "/", key: "v1.abc" } }],
    // The Worker counts created stubs now, so the browser may not report them.
    ["the retired stub_generated event", { event: "stub_generated", properties: { ttl_seconds: 3600 } }],
    ["an untracked path", { event: "page_viewed", properties: { path: "/admin" } }],
    ["a missing property", { event: "page_viewed", properties: {} }],
    ["pasted content smuggled in", { event: "page_viewed", properties: { path: "/", text: "API_KEY=x" } }],
    ["only optional properties", { event: "page_viewed", properties: { utm_source: "hn" } }],
    ["non-object properties", { event: "page_viewed", properties: "/" }],
    ["an unknown utm key", landing({ utm_content: "hero" })],
    ["utm_term", landing({ utm_term: "secrets" })],
    ["an over-long utm value", landing({ utm_source: "a".repeat(41) })],
    ["an empty utm value", landing({ utm_source: "" })],
    ["an uppercase utm value", landing({ utm_medium: "Email" })],
    ["a utm value with odd characters", landing({ utm_campaign: "v1.abc#key" })],
    ["a non-string utm value", landing({ utm_source: 7 })],
    ["a referrer with a path", landing({ referring_domain: "example.com/private/page" })],
    ["a full referrer URL", landing({ referring_domain: "https://example.com" })],
    ["a referrer with a query", landing({ referring_domain: "example.com?q=1" })],
    ["a referrer with a port", landing({ referring_domain: "example.com:8080" })],
    ["an uppercase referrer", landing({ referring_domain: "Example.com" })],
    ["an over-long referrer", landing({ referring_domain: `${"a.".repeat(126)}com` })],
    ["an empty referrer", landing({ referring_domain: "" })],
    ["an IPv4 referrer", landing({ referring_domain: "192.168.1.10" })],
    ["a single-label referrer", landing({ referring_domain: "intranet" })],
    ["a referrer on /t", { event: "page_viewed", properties: { path: "/t", referring_domain: "example.com" } }],
    ["utm_source on /t", { event: "page_viewed", properties: { path: "/t", utm_source: "hn" } }],
    ["utm_medium on /t", { event: "page_viewed", properties: { path: "/t", utm_medium: "email" } }],
    ["utm_campaign on /t", { event: "page_viewed", properties: { path: "/t", utm_campaign: "launch" } }],
  ])("rejects the whole batch for %s", (_name, bad) => {
    expect(parseAnalyticsBatch(batch(view, bad))).toBeNull();
  });

  it.each([
    ["no events", batch()],
    ["too many events", batch(...Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => view))],
    ["a non-UUID session", { sessionId: "v1.secret-looking", events: [view] }],
    ["a UUIDv1 session", { sessionId: "123e4567-e89b-12d3-a456-426614174000", events: [view] }],
    ["a non-object", "page_viewed"],
  ])("rejects %s", (_name, value) => {
    expect(parseAnalyticsBatch(value)).toBeNull();
  });
});
