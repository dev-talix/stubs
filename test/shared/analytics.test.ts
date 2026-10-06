import { describe, expect, it } from "vitest";
import { MAX_EVENTS_PER_BATCH, parseAnalyticsBatch } from "../../src/shared/analytics";

const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const view = { event: "page_viewed", properties: { path: "/t" } };
const generated = { event: "stub_generated", properties: { ttl_seconds: 3600 } };
const batch = (...events: unknown[]) => ({ sessionId: SESSION, events });

describe("parseAnalyticsBatch", () => {
  it("accepts the two allowlisted events", () => {
    expect(parseAnalyticsBatch(batch(view, generated))).toEqual({ sessionId: SESSION, events: [view, generated] });
  });

  it.each([
    ["an unknown event", { event: "stub_opened", properties: {} }],
    ["an inherited name", { event: "constructor", properties: {} }],
    ["a path with a fragment", { event: "page_viewed", properties: { path: "/t#v1.abc" } }],
    ["a path with a query", { event: "page_viewed", properties: { path: "/?x=1" } }],
    ["an extra property", { event: "page_viewed", properties: { path: "/", key: "v1.abc" } }],
    ["a missing property", { event: "stub_generated", properties: {} }],
    ["an unoffered ttl", { event: "stub_generated", properties: { ttl_seconds: 61 } }],
    ["pasted content smuggled in", { event: "stub_generated", properties: { ttl_seconds: 3600, text: "API_KEY=x" } }],
    ["non-object properties", { event: "page_viewed", properties: "/" }],
  ])("rejects the whole batch for %s", (_name, bad) => {
    expect(parseAnalyticsBatch(batch(view, bad))).toBeNull();
  });

  it.each([
    ["no events", batch()],
    ["too many events", batch(...Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => view))],
    ["a non-UUID session", { sessionId: "v1.secret-looking", events: [view] }],
    ["a non-object", "page_viewed"],
  ])("rejects %s", (_name, value) => {
    expect(parseAnalyticsBatch(value)).toBeNull();
  });
});
