import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENTS_ROUTE } from "../../src/shared/analytics";
import handler from "../../src/worker/index";

const ORIGIN = "https://stubs.test";
const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const VALID = {
  sessionId: SESSION,
  events: [
    { event: "page_viewed", properties: { path: "/t" } },
    { event: "stub_generated", properties: { ttl_seconds: 300 } },
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
          $lib: "stubs",
          $process_person_profile: false,
          $geoip_disable: true,
        },
      }),
      expect.objectContaining({
        event: "stub_generated",
        properties: expect.objectContaining({ ttl_seconds: 300 }),
      }),
    ]);
    expect(String(init?.body)).not.toContain("#");
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
