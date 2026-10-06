import { describe, expect, it } from "vitest";
import { DEFAULT_ORIGIN, parseLink, resolveOrigin } from "../src/links";
import { redact } from "../src/redact";

const KEY = "k".repeat(43);
const LINK = `https://stubs.talix.app/t#v1.${KEY}`;

describe("resolveOrigin", () => {
  it("prefers the flag, then the environment, then the default", () => {
    expect(resolveOrigin("http://127.0.0.1:8787/", "https://env.test")).toBe("http://127.0.0.1:8787");
    expect(resolveOrigin(undefined, "https://env.test")).toBe("https://env.test");
    expect(resolveOrigin(undefined, "")).toBe(DEFAULT_ORIGIN);
    expect(resolveOrigin(undefined, undefined)).toBe(DEFAULT_ORIGIN);
  });

  it.each(["not a url", "ftp://stubs.talix.app", "javascript:alert(1)"])("rejects %j", (origin) => {
    expect(resolveOrigin(origin, undefined)).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("parseLink", () => {
  it("reads the default origin's links", () => {
    expect(parseLink(LINK, DEFAULT_ORIGIN)).toEqual({ origin: DEFAULT_ORIGIN, capability: KEY });
    expect(parseLink(`  ${LINK}\n`, DEFAULT_ORIGIN)).toMatchObject({ capability: KEY });
  });

  it("reads links from an explicitly trusted origin", () => {
    const link = `http://127.0.0.1:8787/t#v1.${KEY}`;
    expect(parseLink(link, "http://127.0.0.1:8787")).toMatchObject({ capability: KEY });
  });

  it.each([
    ["another origin", `https://evil.example/t#v1.${KEY}`],
    ["http on the default host", `http://stubs.talix.app/t#v1.${KEY}`],
    ["a lookalike subdomain", `https://stubs.talix.app.evil.example/t#v1.${KEY}`],
    ["a different port", `https://stubs.talix.app:8443/t#v1.${KEY}`],
    ["a different path", `https://stubs.talix.app/x#v1.${KEY}`],
    ["no fragment", "https://stubs.talix.app/t"],
    ["a short key", `https://stubs.talix.app/t#v1.${KEY.slice(1)}`],
    ["a future version", `https://stubs.talix.app/t#v9.${KEY}`],
    ["garbage", "hello"],
  ])("refuses %s as invalid without echoing it", (_, link) => {
    const result = parseLink(link, DEFAULT_ORIGIN);
    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(JSON.stringify(result)).not.toContain(KEY.slice(0, 20));
  });
});

describe("parseLink strict shape", () => {
  const PLAIN = "That isn't a plain Stubs link (stubs.talix.app/t#…). Nothing was consumed.";

  it.each([
    ["a query string", `https://stubs.talix.app/t?x=1#v1.${KEY}`],
    ["a single quote", `https://stubs.talix.app/t#v1.${KEY}'; rm -rf ~; '`],
    ["a semicolon", `https://stubs.talix.app/t#v1.${KEY};ls`],
    ["command substitution", `https://stubs.talix.app/t#v1.${KEY}$(id)`],
    ["backticks", "https://stubs.talix.app/t#v1.`id`"],
    ["a space inside", `https://stubs.talix.app/t #v1.${KEY}`],
    ["user credentials", `https://user@stubs.talix.app/t#v1.${KEY}`],
    ["user and password", `https://user:pw@stubs.talix.app/t#v1.${KEY}`],
    ["a percent-encoded quote in the path", `https://stubs.talix.app/t%27#v1.${KEY}`],
    ["a percent-encoded quote in the fragment", `https://stubs.talix.app/t#v1.${KEY}%27`],
    ["a deeper path", `https://stubs.talix.app/t/x#v1.${KEY}`],
  ])("refuses %s", (_, link) => {
    expect(parseLink(link, DEFAULT_ORIGIN)).toEqual({ ok: false, code: "invalid", message: PLAIN });
  });

  it("keeps its message intact through output redaction", () => {
    expect(redact(PLAIN)).toBe(PLAIN);
  });

  it("names the configured origin's host", () => {
    expect(parseLink("http://127.0.0.1:8787/t?x#v1.k", "http://127.0.0.1:8787")).toMatchObject({
      message: "That isn't a plain Stubs link (127.0.0.1:8787/t#…). Nothing was consumed.",
    });
  });

  it("accepts /t/ as /t, and the default port spelled out", () => {
    expect(parseLink(`https://stubs.talix.app/t/#v1.${KEY}`, DEFAULT_ORIGIN)).toEqual({ origin: DEFAULT_ORIGIN, capability: KEY });
    expect(parseLink(`https://stubs.talix.app:443/t#v1.${KEY}`, DEFAULT_ORIGIN)).toMatchObject({ capability: KEY });
  });

  it("accepts a locked v2 link", () => {
    const locked = `${"e".repeat(43)}.${"w".repeat(80)}`;
    expect(parseLink(`https://stubs.talix.app/t#v2.${locked}`, DEFAULT_ORIGIN)).toEqual({ origin: DEFAULT_ORIGIN, locked });
  });
});
