import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENTS_ROUTE, SESSION_MAX_AGE_MS, type AnalyticsBatch } from "../../src/shared/analytics";
import { toPostHogBatch } from "../../src/worker/analytics";
import handler from "../../src/worker/index";

const ORIGIN = "https://stubs.test";
/** A UUIDv7 whose embedded timestamp is `ms`. */
const v7At = (ms: number) => {
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-774b-bcce-b302099a8057`;
};
const SESSION = v7At(Date.now());
const LEGACY_V4_SESSION = "123e4567-e89b-42d3-a456-426614174000";
const VALID = {
  sessionId: SESSION,
  events: [
    { event: "page_viewed", properties: { path: "/t" } },
    { event: "page_viewed", properties: { path: "/" } },
  ],
};

let ip = 0;
async function post(body: unknown, options: { key?: string; headers?: Record<string, string> } = {}) {
  const ctx = createExecutionContext();
  const response = await handler.fetch(
    new Request(`${ORIGIN}${EVENTS_ROUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": `198.51.100.${++ip}`, ...options.headers },
      body: JSON.stringify(body),
    }),
    { ...env, ...(options.key && { POSTHOG_KEY: options.key }) },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/events", () => {
  it("forwards only rebuilt, allowlisted events to PostHog with the server-side key", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const response = await post(VALID, { key: "phc_test_key" });
    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    expect(outbound).toHaveBeenCalledTimes(1);
    const [url, init] = outbound.mock.calls[0]!;
    expect(url).toBe("https://us.i.posthog.com/batch/");
    const sent = JSON.parse(String(init?.body));
    expect(sent.api_key).toBe("phc_test_key");
    expect(sent.batch).toEqual([
      expect.objectContaining({
        event: "$pageview",
        distinct_id: SESSION,
        properties: {
          path: "/t",
          $current_url: `${ORIGIN}/t`,
          $pathname: "/t",
          $session_id: SESSION,
          $lib: "stubs",
          $process_person_profile: false,
          $geoip_disable: true,
        },
      }),
      expect.objectContaining({
        event: "$pageview",
        properties: expect.objectContaining({ path: "/", $pathname: "/", $session_id: SESSION }),
      }),
    ]);
    expect(String(init?.body)).not.toContain("#");
  });

  it("forwards the referring domain and campaign tags for / under PostHog's names", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const landing = {
      path: "/",
      referring_domain: "news.ycombinator.com",
      utm_source: "hn",
      utm_medium: "social",
      utm_campaign: "launch",
    };
    const response = await post({ sessionId: SESSION, events: [{ event: "page_viewed", properties: landing }] }, {
      key: "phc_test_key",
    });
    expect(response.status).toBe(204);

    const [, init] = outbound.mock.calls[0]!;
    const [sent] = JSON.parse(String(init?.body)).batch;
    expect(sent.distinct_id).toBe(SESSION);
    expect(sent.properties).toEqual({
      path: "/",
      $current_url: `${ORIGIN}/`,
      $pathname: "/",
      $referring_domain: "news.ycombinator.com",
      utm_source: "hn",
      utm_medium: "social",
      utm_campaign: "launch",
      $session_id: SESSION,
      $lib: "stubs",
      $process_person_profile: false,
      $geoip_disable: true,
    });
    // Campaign tags travel as their own properties, never as a query string on the URL.
    expect(String(init?.body)).not.toContain("?");
  });

  it("rejects a referrer or campaign tags on /t without forwarding anything", async () => {
    const outbound = vi.spyOn(globalThis, "fetch");
    for (const extra of [{ referring_domain: "example.com" }, { utm_source: "hn" }]) {
      const response = await post(
        { sessionId: SESSION, events: [{ event: "page_viewed", properties: { path: "/t", ...extra } }] },
        { key: "phc_test_key" },
      );
      expect(response.status).toBe(400);
    }
    expect(outbound).not.toHaveBeenCalled();
  });

  it("still forwards a pre-v7 tab's v4 id, just without $session_id", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const response = await post({ ...VALID, sessionId: LEGACY_V4_SESSION }, { key: "phc_test_key" });
    expect(response.status).toBe(204);

    const [, init] = outbound.mock.calls[0]!;
    const sent = JSON.parse(String(init?.body)).batch;
    expect(sent).toHaveLength(2);
    for (const event of sent) {
      expect(event.distinct_id).toBe(LEGACY_V4_SESSION);
      expect(event.properties).not.toHaveProperty("$session_id");
    }
  });

  it("accepts but drops events when no key is configured", async () => {
    const outbound = vi.spyOn(globalThis, "fetch");
    expect((await post(VALID)).status).toBe(204);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects off-schema batches without forwarding anything", async () => {
    const outbound = vi.spyOn(globalThis, "fetch");
    const smuggled = {
      sessionId: SESSION,
      events: [{ event: "page_viewed", properties: { path: "/t", url: "https://stubs.talix.app/t#v1.key" } }],
    };
    const response = await post(smuggled, { key: "phc_test_key" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("refuses cross-site posts", async () => {
    const response = await post(VALID, { key: "k", headers: { Origin: "https://evil.example" } });
    expect(response.status).toBe(403);
  });

  it("keeps the response fast and quiet when PostHog is down", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    expect((await post(VALID, { key: "k" })).status).toBe(204);
    expect(log.mock.calls).toEqual([["analytics_forward_failed", "TypeError"]]);
  });

  it("rate limits each client", async () => {
    const headers = { "CF-Connecting-IP": "203.0.113.200" };
    let limited = false;
    for (let i = 0; i < 200 && !limited; i++) limited = (await post(VALID, { headers })).status === 429;
    expect(limited).toBe(true);
  });
});

describe("toPostHogBatch $session_id", () => {
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const sessionAt = (ms: number) =>
    toPostHogBatch({ ...(VALID as AnalyticsBatch), sessionId: v7At(ms) }, "k", ORIGIN, new Date(now)).batch.map(
      (event) => (event.properties as Record<string, unknown>).$session_id,
    );

  it.each([
    ["started just now", now],
    ["started an hour ago", now - 60 * 60 * 1000],
    ["just under 24 hours old", now - SESSION_MAX_AGE_MS + 1],
  ])("keeps an id that %s", (_name, startedAt) => {
    expect(sessionAt(startedAt)).toEqual([v7At(startedAt), v7At(startedAt)]);
  });

  it.each([
    ["is from a browser clock a minute ahead", now + 60 * 1000],
    ["is exactly 24 hours old", now - SESSION_MAX_AGE_MS],
    ["is from a tab open for 25 hours", now - 25 * 60 * 60 * 1000],
  ])("drops the property, but keeps the event, for an id that %s", (_name, startedAt) => {
    expect(sessionAt(startedAt)).toEqual([undefined, undefined]);
  });
});
