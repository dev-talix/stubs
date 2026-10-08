// Replaces env values in a byte stream with `[stubs:KEY]` before the stream reaches a terminal
// or an agent's transcript. Works on bytes, so binary output passes through untouched and a
// value split across two chunks is still caught: the tail of a chunk that could be the start
// of a value is held back until the next chunk or the end of the stream decides. The held
// tail is never longer than the longest value, and no timer ever lets it out early: a value
// written in two halves with a pause between them stays masked however long the pause.
//
// Each value is also searched for in the forms tools commonly print it in: JSON-escaped (as
// JavaScript writes it; with non-ASCII characters as \uXXXX, as Python's json.dumps does;
// with <, >, & and U+2028/2029 escaped too, as Go's encoding/json does by default; and each
// of those with upper-case hex digits), URL-encoded, base64 and base64url (at every byte
// alignment, so a password inside a Basic auth header is caught), and line by line for
// multi-line values such as PEM keys. Exactly those forms, nothing more: a serializer that
// escapes other characters (quotes as \u0022, say) isn't covered.
// Values shorter than MIN_MASKED_LENGTH aren't masked at all: `true`, `3000`, or `dev` aren't
// secrets, and blanking them would hit ordinary words all over the output.

export const MIN_MASKED_LENGTH = 6;

export interface Needle {
  bytes: Buffer;
  key: string;
}

export function placeholder(key: string): string {
  return `[stubs:${key}]`;
}

/** Every byte sequence that reveals `value`, each tagged with its key. */
export function needlesFor(key: string, value: string): Needle[] {
  if (value.length < MIN_MASKED_LENGTH) return [];
  const texts = new Set<string>();
  const add = (text: string) => {
    if (text.length >= MIN_MASKED_LENGTH) texts.add(text);
  };
  add(value);
  for (const line of value.split(/\r?\n/)) add(line.trim());
  const json = JSON.stringify(value).slice(1, -1);
  for (const form of [json, json.replace(/[<>&\u2028\u2029]/g, unicodeEscape)]) {
    for (const text of [form, form.replace(/[\u0080-\uffff]/g, unicodeEscape)]) {
      add(text);
      add(text.replace(/\\u([0-9a-f]{4})/g, (_, hex: string) => `\\u${hex.toUpperCase()}`));
    }
  }
  const url = encodeURIComponent(value);
  add(url);
  add(url.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()));
  add(url.replace(/%20/g, "+"));
  for (const core of base64Cores(value)) add(core);
  return [...texts].map((text) => ({ bytes: Buffer.from(text, "utf8"), key }));
}

const unicodeEscape = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;

/**
 * The base64 characters that depend only on `value`'s bytes, for each of the three ways the
 * value can sit against a 3-byte group boundary. A character shared with a neighbouring byte
 * (at most one on each side) is left out, so the core matches wherever the value appears
 * inside a longer encoded string. When the value ends the string, the last group is fixed by
 * the padding, so that longer form (with and without `=`) is included too.
 */
function base64Cores(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const cores: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
    // Chars before `start` depend on the prefix bytes. In the last partial group, the first
    // `leftover` chars depend on the value alone; the next one also on whatever follows.
    const start = [0, 2, 3][offset]!;
    const leftover = padded.length % 3;
    const end = Math.floor(padded.length / 3) * 4 + leftover;
    for (const encoding of ["base64", "base64url"] as const) {
      const text = padded.toString(encoding);
      cores.push(text.slice(start, end), text.slice(start), text.slice(start).replace(/=+$/, ""));
    }
  }
  return cores;
}

export class Masker {
  private readonly byFirstByte: (Needle[] | undefined)[] = new Array(256);
  private readonly placeholders = new Map<string, Buffer>();
  private pending: Buffer = Buffer.alloc(0);

  constructor(needles: Needle[]) {
    for (const needle of needles) {
      if (needle.bytes.length === 0) continue;
      (this.byFirstByte[needle.bytes[0]!] ??= []).push(needle);
      if (!this.placeholders.has(needle.key)) {
        this.placeholders.set(needle.key, Buffer.from(placeholder(needle.key), "utf8"));
      }
    }
    // Longest first, so a value that starts with another value wins over it.
    for (const bucket of this.byFirstByte) bucket?.sort((a, b) => b.bytes.length - a.bytes.length);
  }

  /** Masks what can be decided now. A tail that might be the start of a value is held back. */
  push(chunk: Buffer): Buffer {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    return this.drain(false);
  }

  /** Releases the held tail. Only for the end of the stream: nothing more can arrive to decide it. */
  flush(): Buffer {
    return this.drain(true);
  }

  private drain(final: boolean): Buffer {
    const text = this.pending;
    const parts: Buffer[] = [];
    let emitted = 0;
    let i = 0;
    while (i < text.length) {
      const bucket = this.byFirstByte[text[i]!];
      if (bucket === undefined) {
        i++;
        continue;
      }
      let hit: Needle | undefined;
      let hold = false;
      for (const needle of bucket) {
        const n = needle.bytes;
        const remaining = text.length - i;
        if (n.length <= remaining) {
          if (text.compare(n, 0, n.length, i, i + n.length) === 0) {
            hit = needle;
            break;
          }
        } else if (!final && n.compare(text, i, text.length, 0, remaining) === 0) {
          hold = true;
          break;
        }
      }
      if (hold) break;
      if (hit === undefined) {
        i++;
        continue;
      }
      parts.push(text.subarray(emitted, i), this.placeholders.get(hit.key)!);
      i += hit.bytes.length;
      emitted = i;
    }
    parts.push(text.subarray(emitted, i));
    this.pending = text.subarray(i);
    return Buffer.concat(parts);
  }
}
