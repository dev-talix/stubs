import { afterEach, describe, expect, it, vi } from "vitest";
import { readAcquisition, track, uuidv7 } from "../../src/client/analytics";
import { SESSION_MAX_AGE_MS, parseAnalyticsBatch } from "../../src/shared/analytics";

const ORIGIN = "https://stubs.talix.app";

describe("readAcquisition", () => {
  it("keeps only the referring hostname, never its path or query", () => {
    expect(readAcquisition("https://News.YCombinator.com:8443/item?id=1#top", "", ORIGIN)).toEqual({
      referring_domain: "news.ycombinator.com",
    });
  });

  it.each([
    ["no referrer", ""],
    ["this site", `${ORIGIN}/t`],
    ["an IPv6 host", "http://[::1]/page"],
    ["an IPv4 host", "http://10.0.0.5:8080/admin"],
    ["a single-label intranet host", "http://wiki/page"],
  ])("leaves out the referrer for %s", (_name, referrer) => {
    expect(readAcquisition(referrer, "", ORIGIN)).toEqual({});
  });

  it("reads only the three campaign tags, lowercased", () => {
    const search = "?utm_source=HN&utm_medium=social&utm_campaign=launch_2026&utm_term=secret&ref=me";
    expect(readAcquisition("", search, ORIGIN)).toEqual({
      utm_source: "hn",
      utm_medium: "social",
      utm_campaign: "launch_2026",
    });
  });

  it("drops off-contract tag values but keeps the rest", () => {
    const search = `?utm_source=${"a".repeat(41)}&utm_medium=e%20mail&utm_campaign=ok`;
    expect(readAcquisition("", search, ORIGIN)).toEqual({ utm_campaign: "ok" });
  });

  it("always produces a page view the Worker accepts", () => {
    const acquisition = readAcquisition("https://x.com/a/b?c=d", "?utm_source=x&utm_medium=%3Cscript%3E", ORIGIN);
    const batch = { sessionId: uuidv7(), events: [{ event: "page_viewed", properties: { path: "/", ...acquisition } }] };
    expect(parseAnalyticsBatch(batch)).not.toBeNull();
  });
});

describe("uuidv7", () => {
  it("leads with the millisecond timestamp and sets the version and variant", () => {
    const now = Date.UTC(2026, 9, 8, 12, 0, 0, 123);
    const id = uuidv7(now);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(now);
    expect(uuidv7(now)).not.toBe(id);
  });
});

describe("track", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps one session id per page load, and starts a new one after 24 hours", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.stubGlobal("navigator", {});
    const sent = vi.fn((_route: string, _init: RequestInit) => Promise.resolve(new Response()));
    vi.stubGlobal("fetch", sent);
    const sessionOf = (call: number) => JSON.parse(String(sent.mock.calls[call]![1].body)).sessionId as string;
    const view = { event: "page_viewed", properties: { path: "/" } } as const;

    track(view);
    vi.setSystemTime(Date.now() + 60 * 1000);
    track(view);
    vi.setSystemTime(Date.now() + SESSION_MAX_AGE_MS);
    track(view);

    expect(sessionOf(1)).toBe(sessionOf(0));
    expect(sessionOf(2)).not.toBe(sessionOf(0));
    expect(parseInt(sessionOf(2).replace(/-/g, "").slice(0, 12), 16)).toBe(Date.now());
  });
});
