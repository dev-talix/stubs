// The last line of defence for R6: anything that looks like a link, a fragment, a key, or a
// public id is replaced before it reaches a stream or an MCP result. Messages are written not
// to need it; this catches what a message echoes from input (a path, a flag) by accident.

const PATTERNS = [
  /https?:\/\/\S+/g,
  /#v\d+\.[A-Za-z0-9_.-]+/g,
  /stubs1[A-Za-z0-9_-]{43}/g,
  /[A-Za-z0-9_-]{43,}/g,
];

export const REDACTED = "<redacted>";

export function redact(text: string): string {
  return PATTERNS.reduce((result, pattern) => result.replace(pattern, REDACTED), text);
}

/** Redacts every string inside a JSON-shaped value, so the serialized form stays valid JSON. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)])) as T;
  }
  return value;
}
