// Reads .env text into rows for display and per-key copying. The raw text is
// what gets encrypted, so this parser never changes what the recipient gets.

export type EnvLine =
  | { kind: "pair"; line: number; key: string; value: string }
  | { kind: "invalid"; line: number; text: string };

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t" };

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function parseDotenv(source: string): EnvLine[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const result: EnvLine[] = [];
  // Quote characters already known to never close before the end of the input. Rescanning
  // for them from every later line would make crafted input quadratic.
  const unclosed = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const body = trimmed.replace(/^export\s+/, "");
    const eq = body.indexOf("=");
    const key = eq === -1 ? "" : body.slice(0, eq).trim();
    if (!KEY_PATTERN.test(key)) {
      result.push({ kind: "invalid", line: lineNumber, text: trimmed });
      continue;
    }

    const rest = body.slice(eq + 1).trimStart();
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      if (unclosed.has(quote)) {
        result.push({ kind: "invalid", line: lineNumber, text: trimmed });
        continue;
      }
      // Quoted values may span lines, as dotenv allows. Lines are scanned in place, never
      // concatenated, so each one is read once however long the value runs.
      const segments: string[] = [];
      let text = rest.slice(1);
      let end = findClosingQuote(text, quote);
      let last = i;
      while (end === -1 && last + 1 < lines.length) {
        segments.push(text);
        last++;
        text = lines[last] ?? "";
        end = findClosingQuote(text, quote);
      }
      if (end === -1) {
        unclosed.add(quote);
        result.push({ kind: "invalid", line: lineNumber, text: trimmed });
        continue;
      }
      i = last;
      segments.push(text.slice(0, end));
      let value = segments.join("\n");
      if (quote === '"') value = value.replace(/\\([nrt"\\])/g, (_, c: string) => ESCAPES[c] ?? c);
      result.push({ kind: "pair", line: lineNumber, key, value });
      continue;
    }

    // Unquoted: an inline comment needs whitespace before the #. A plain search, not a
    // backtracking regex: a long run of spaces must not freeze the page.
    const comment = rest.search(/\s#/);
    const value = (comment === -1 ? rest : rest.slice(0, comment)).trim();
    result.push({ kind: "pair", line: lineNumber, key, value });
  }

  return result;
}

/** Index of the closing quote in `text`, or -1. A backslash escapes the next character. */
function findClosingQuote(text: string, quote: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && quote === '"') {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

export type EnvPair = Extract<EnvLine, { kind: "pair" }>;

export function pairsOf(lines: EnvLine[]): EnvPair[] {
  return lines.filter((line): line is EnvPair => line.kind === "pair");
}
