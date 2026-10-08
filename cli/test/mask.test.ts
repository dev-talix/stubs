import { describe, expect, it } from "vitest";
import { Masker, MIN_MASKED_LENGTH, needlesFor, placeholder } from "../src/mask";

const SECRET = "hunter2-9f3a";
const masker = (pairs: Record<string, string>) =>
  new Masker(Object.entries(pairs).flatMap(([key, value]) => needlesFor(key, value)));

/** Feeds `text` in pieces of `size` bytes and returns everything the masker let through. */
function stream(m: Masker, text: string, size: number): string {
  const bytes = Buffer.from(text, "utf8");
  const out: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(m.push(bytes.subarray(i, i + size)));
  out.push(m.flush());
  return Buffer.concat(out).toString("utf8");
}

describe("needlesFor", () => {
  it("skips values shorter than the minimum", () => {
    expect(MIN_MASKED_LENGTH).toBe(6);
    expect(needlesFor("PORT", "3000")).toEqual([]);
    expect(needlesFor("DEBUG", "true")).toEqual([]);
    expect(needlesFor("X", "a".repeat(MIN_MASKED_LENGTH))).not.toEqual([]);
  });

  it("covers the encodings tools print values in", () => {
    const texts = needlesFor("K", 'p@ss "word" & more').map((n) => n.bytes.toString("utf8"));
    expect(texts).toContain('p@ss "word" & more');
    expect(texts).toContain('p@ss \\"word\\" & more');
    expect(texts).toContain("p%40ss%20%22word%22%20%26%20more");
    expect(texts).toContain("p%40ss+%22word%22+%26+more");
    expect(texts).toContain(Buffer.from('p@ss "word" & more').toString("base64").replace(/=+$/, ""));
  });

  it("covers exactly these JSON forms: JavaScript, Python, Go, and each with upper-case hex", () => {
    const texts = needlesFor("K", "p<ä&s>s \u2028word-123 \u{1F600}").map((n) => n.bytes.toString("utf8"));
    // JavaScript: only control characters and quotes escaped.
    expect(texts).toContain("p<ä&s>s \u2028word-123 \u{1F600}");
    // Python json.dumps and Java: non-ASCII as lower-case \uXXXX, astral characters as pairs.
    expect(texts).toContain("p<\\u00e4&s>s \\u2028word-123 \\ud83d\\ude00");
    // Go encoding/json: <, >, & and U+2028/2029 escaped, other non-ASCII kept.
    expect(texts).toContain("p\\u003cä\\u0026s\\u003es \\u2028word-123 \u{1F600}");
    // Both of the above with upper-case hex digits.
    expect(texts).toContain("p\\u003C\\u00E4\\u0026s\\u003Es \\u2028word-123 \\uD83D\\uDE00");
    // Not covered: serializers that also escape quotes or apostrophes numerically.
    expect(texts).not.toContain("p\\u003C\\u00E4\\u0026s\\u003Es \\u2028word-123 \\uD83D\\uDE00".replace("word", "wor\\u0027d"));
  });
});

describe("Masker", () => {
  it("replaces every occurrence with the key's placeholder", () => {
    const m = masker({ API_KEY: SECRET });
    expect(stream(m, `key=${SECRET} again ${SECRET}\n`, 1024)).toBe("key=[stubs:API_KEY] again [stubs:API_KEY]\n");
  });

  it.each([1, 2, 3, 5, 7])("catches a value split across chunks of %d bytes", (size) => {
    const m = masker({ API_KEY: SECRET });
    expect(stream(m, `start ${SECRET} end`, size)).toBe("start [stubs:API_KEY] end");
  });

  it("holds back a tail that could start a value until it's decided, and never more than a value's length", () => {
    const m = masker({ API_KEY: SECRET });
    expect(m.push(Buffer.from("x hunter2")).toString()).toBe("x ");
    expect(m.push(Buffer.from("-9f3a!")).toString()).toBe("[stubs:API_KEY]!");
    expect(m.push(Buffer.from("hunter")).toString()).toBe("");
    expect(m.flush().toString()).toBe("hunter");
    expect(m.push(Buffer.from("hunter2-9f3")).toString()).toBe("");
    expect(m.push(Buffer.from("x hunter2-9f3")).toString()).toBe("hunter2-9f3x ");
  });

  it("prefers the longer value when one starts with another", () => {
    const m = masker({ SHORT: "abcdef", LONG: "abcdefghij" });
    expect(stream(m, "abcdefghij abcdef abcdefg", 4)).toBe("[stubs:LONG] [stubs:SHORT] [stubs:SHORT]g");
  });

  it("masks base64, base64url, URL-encoded, and JSON-escaped forms", () => {
    const value = "sk-live/abc+def ghi?";
    const m = masker({ TOKEN: value });
    const b64 = Buffer.from(value).toString("base64");
    const b64url = Buffer.from(value).toString("base64url");
    const out = stream(m, `${b64}\n${b64url}\n${encodeURIComponent(value)}\n${JSON.stringify(value)}\n`, 1024);
    expect(out).not.toContain("abc+def");
    expect(out).not.toContain("abc%2Bdef");
    expect(out).not.toContain("abc-def");
    expect(out.split("[stubs:TOKEN]")).toHaveLength(5);
  });

  it("masks a value base64-encoded at any alignment, as in a Basic auth header", () => {
    const password = "correct-horse-battery";
    const m = masker({ DB_PASSWORD: password });
    for (const user of ["a", "ab", "abc", "alice"]) {
      const encoded = Buffer.from(`${user}:${password}`).toString("base64");
      const out = stream(m, `Authorization: Basic ${encoded}`, 1024);
      // The value ends the string, so the mask runs to the end; at most one character after
      // the prefix (the one sharing bits with it) can survive.
      expect(out.endsWith("[stubs:DB_PASSWORD]")).toBe(true);
      expect(out).not.toContain(encoded.slice(3));
    }
    const mid = stream(m, `x ${Buffer.from(`u:${password}:more-after`).toString("base64")} y`, 1024);
    expect(mid).toContain("[stubs:DB_PASSWORD]");
    expect(mid).not.toContain(Buffer.from(`u:${password}:more-after`).toString("base64").slice(3, -5));
  });

  it("masks each line of a multi-line value as well as the whole", () => {
    const pem = "-----BEGIN KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASC\nAAAAB3NzaC1yc2EAAAADAQABAAABAQ==\n-----END KEY-----";
    const m = masker({ PRIVATE_KEY: pem });
    expect(stream(m, `${pem}\n`, 16)).toBe("[stubs:PRIVATE_KEY]\n");
    const oneLine = stream(m, "line: AAAAB3NzaC1yc2EAAAADAQABAAABAQ==\n", 16);
    expect(oneLine).toBe("line: [stubs:PRIVATE_KEY]\n");
  });

  it("passes bytes that aren't UTF-8 through untouched", () => {
    const m = masker({ API_KEY: SECRET });
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x68, 0x75, 0x6e]);
    expect(Buffer.concat([m.push(binary), m.flush()])).toEqual(binary);
  });

  it("does nothing with no needles", () => {
    const m = new Masker([]);
    expect(stream(m, `plain ${SECRET}`, 3)).toBe(`plain ${SECRET}`);
  });

  it("names the placeholder after the key", () => {
    expect(placeholder("DB_URL")).toBe("[stubs:DB_URL]");
  });
});
