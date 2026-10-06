import { describe, expect, it } from "vitest";
import { redact, redactDeep } from "../src/redact";

const KEY = "Abc_-123".repeat(6).slice(0, 43);

describe("redact", () => {
  it.each([
    [`see https://stubs.talix.app/t#v1.${KEY} now`, "see <redacted> now"],
    [`http://127.0.0.1:8787/x`, "<redacted>"],
    [`file #v1.${KEY}`, "file <redacted>"],
    [`#v2.${KEY}.${KEY}`, "<redacted>"],
    [`id stubs1${KEY}`, "id <redacted>"],
    [`--${KEY}`, "<redacted>"],
    [`a ${"x".repeat(42)} b`, `a ${"x".repeat(42)} b`],
    ["Pulled 2 values into .env.local: API_KEY, DB_URL", "Pulled 2 values into .env.local: API_KEY, DB_URL"],
  ])("redacts %j", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("redacts inside JSON-shaped values and keeps them valid", () => {
    const value = { ok: false, message: `bad https://x.test/t#v1.${KEY}, "quoted"`, list: [KEY], n: 1 };
    const text = JSON.stringify(redactDeep(value));
    expect(JSON.parse(text)).toEqual({ ok: false, message: 'bad <redacted> "quoted"', list: ["<redacted>"], n: 1 });
  });
});
