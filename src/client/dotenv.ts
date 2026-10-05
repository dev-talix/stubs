// Reads .env text into rows for display and per-key copying. The raw text is
// what gets encrypted, so this parser never changes what the recipient gets.

export type EnvLine =
  | { kind: "pair"; line: number; key: string; value: string }
  | { kind: "invalid"; line: number; text: string };

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t" };

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function parseDotenv(source: string): EnvLine[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const result: EnvLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const body = trimmed.replace(/^export\s+/, "");
    const eq = body.indexOf("=");
    const key = eq === -1 ? "" : body.slice(0, eq).trim();
    if (!KEY.test(key)) {
      result.push({ kind: "invalid", line: lineNumber, text: trimmed });
      continue;
    }

    let rest = body.slice(eq + 1).trimStart();
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      // Quoted values may span lines, as dotenv allows.
      const start = i;
      let end = findClosingQuote(rest, quote);
      while (end === -1 && i + 1 < lines.length) {
        i++;
        rest += "\n" + (lines[i] ?? "");
        end = findClosingQuote(rest, quote);
      }
      if (end === -1) {
        i = start;
        result.push({ kind: "invalid", line: lineNumber, text: trimmed });
        continue;
      }
      let value = rest.slice(1, end);
      if (quote === '"') value = value.replace(/\\([nrt"\\])/g, (_, c: string) => ESCAPES[c] ?? c);
      result.push({ kind: "pair", line: lineNumber, key, value });
      continue;
    }

    // Unquoted: an inline comment needs whitespace before the #.
    const value = rest.replace(/\s+#.*$/, "").trim();
    result.push({ kind: "pair", line: lineNumber, key, value });
  }

  return result;
}

function findClosingQuote(text: string, quote: string): number {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\" && quote === '"') {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}
