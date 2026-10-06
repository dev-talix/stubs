// Merges pulled pairs into an env file without disturbing what's already there, and writes it
// atomically with tight permissions. Values pass through here but are never logged or returned.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pairsOf, parseDotenv, type EnvPair } from "../../src/core/dotenv";

/**
 * Quotes a value only when a dotenv parser would otherwise misread it, and prefers quote styles
 * every common parser reads literally. Single quotes first: npm `dotenv` (Next.js, most Node
 * tools) and our own parser both take them verbatim, and `dotenv-expand` leaves `$` alone
 * inside them. Backticks next. Double quotes only for newlines (the one case all parsers
 * agree needs `\n`), where npm `dotenv` keeps a `\"` or `\\` as typed; that combination is rare.
 */
export function formatValue(value: string): string {
  if (!/[\s#"'`$\\]/.test(value)) return value;
  const multiline = /[\n\r]/.test(value);
  if (!multiline && !value.includes("'")) return `'${value}'`;
  if (!multiline && !value.includes("`")) return `\`${value}\``;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

export function formatLine(key: string, value: string): string {
  return `${key}=${formatValue(value)}`;
}

export interface MergePlan {
  /** The new file contents, or null when nothing changes. */
  content: Buffer | null;
  written: string[];
  skipped: string[];
  unparsed: number;
  /** 1-based lines of the existing file that parseDotenv couldn't read. */
  malformedLines: number[];
}

/** Prefix for pulled lines that aren't KEY=VALUE, kept as comments so nothing is lost. */
export const UNPARSED_PREFIX = "# unparsed: ";
/** Prefix for pulled values whose key was already set; kept so the consumed stub isn't lost. */
export const SKIPPED_PREFIX = "# stubs skipped (already set): ";

/**
 * Merges pulled .env text into an existing file. Keys already in the file are skipped, with the
 * pulled value kept in a comment, unless `overwrite`, in which case their lines are replaced in
 * place. Pulled lines that aren't pairs are appended as comments. Every existing line that isn't
 * replaced is written back as its original bytes.
 */
export function mergeEnv(existing: Buffer | null, pulled: string, overwrite: boolean): MergePlan {
  const base = existing ?? Buffer.alloc(0);
  const lines = splitLines(base);
  const existingLines = parseDotenv(lines.map((line) => line.text).join("\n"));
  const malformedLines = existingLines.filter((line) => line.kind === "invalid").map((line) => line.line);
  const current = new Map<string, EnvPair[]>();
  for (const pair of pairsOf(existingLines)) {
    current.set(pair.key, [...(current.get(pair.key) ?? []), pair]);
  }

  const pulledLines = parseDotenv(pulled);
  const sourceLines = pulled.split(/\r\n|\r|\n/);
  const unparsedLines = pulledLines
    .filter((line) => line.kind === "invalid")
    .map((line) => UNPARSED_PREFIX + (sourceLines[line.line - 1] ?? "").trim());

  // Later duplicates win, as in dotenv, but a key keeps its first position.
  const wanted = new Map<string, string>();
  for (const pair of pairsOf(pulledLines)) wanted.set(pair.key, pair.value);

  const added: string[] = [];
  const replaced: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of wanted) {
    const found = current.get(key);
    if (!found) added.push(key);
    else if (overwrite && !found.every((pair) => pair.value === value)) replaced.push(key);
    else skipped.push(key);
  }

  const written = [...replaced, ...added];
  const keptSkipped = overwrite ? [] : skipped;
  const appendedLines = [
    ...added.map((key) => formatLine(key, wanted.get(key)!)),
    ...keptSkipped.map((key) => SKIPPED_PREFIX + formatLine(key, wanted.get(key)!)),
    ...unparsedLines,
  ];
  const plan = { written, skipped, unparsed: unparsedLines.length, malformedLines };
  if (replaced.length === 0 && appendedLines.length === 0) return { content: null, ...plan };

  const eol = base.includes("\r\n") ? "\r\n" : "\n";
  let body = base;
  if (replaced.length > 0) {
    const replacements = new Map<number, { end: number; text: string }>();
    for (const key of replaced) {
      for (const pair of current.get(key) ?? []) {
        const span = spanOf(lines, pair);
        replacements.set(span.start, { end: span.end, text: formatLine(key, wanted.get(key)!) });
      }
    }
    const parts: Buffer[] = [];
    for (let i = 0; i < lines.length; i++) {
      const replacement = replacements.get(i);
      if (replacement) {
        parts.push(Buffer.from(replacement.text, "utf8"), lines[replacement.end]!.eol);
        i = replacement.end;
      } else {
        parts.push(lines[i]!.bytes, lines[i]!.eol);
      }
    }
    body = Buffer.concat(parts);
  }

  if (appendedLines.length === 0) return { content: body, ...plan };
  const last = body.length > 0 ? body[body.length - 1] : undefined;
  const separator = last === undefined || last === 0x0a || last === 0x0d ? "" : eol;
  const appended = separator + appendedLines.map((line) => line + eol).join("");
  return { content: Buffer.concat([body, Buffer.from(appended, "utf8")]), ...plan };
}

interface Line {
  /** The line's own bytes, without its terminator. */
  bytes: Buffer;
  /** "\r\n", "\n", "\r", or empty on a final unterminated line. */
  eol: Buffer;
  /** The bytes decoded, for parsing only; never written back. */
  text: string;
}

/**
 * Splits on the same terminators parseDotenv uses (CRLF, LF, lone CR), working on bytes so
 * lines that aren't valid UTF-8 survive untouched. Those bytes never occur inside a multi-byte
 * UTF-8 sequence, so line numbers match a parse of the decoded text.
 */
function splitLines(buffer: Buffer): Line[] {
  const lines: Line[] = [];
  const push = (start: number, end: number, eolEnd: number) => {
    const bytes = buffer.subarray(start, end);
    lines.push({ bytes, eol: buffer.subarray(end, eolEnd), text: bytes.toString("utf8") });
  };
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0a) {
      push(start, i, i + 1);
      start = i + 1;
    } else if (buffer[i] === 0x0d) {
      const eolEnd = buffer[i + 1] === 0x0a ? i + 2 : i + 1;
      push(start, i, eolEnd);
      start = eolEnd;
      i = eolEnd - 1;
    }
  }
  if (start < buffer.length) push(start, buffer.length, buffer.length);
  return lines;
}

/** Zero-based first and last line of a pair; quoted values can span several lines. */
function spanOf(lines: Line[], pair: EnvPair): { start: number; end: number } {
  const start = pair.line - 1;
  for (let end = start; end < lines.length; end++) {
    const chunk = lines
      .slice(start, end + 1)
      .map((line) => line.text)
      .join("\n");
    const first = parseDotenv(chunk)[0];
    if (first?.kind === "pair" && first.line === 1 && first.key === pair.key && first.value === pair.value) {
      return { start, end };
    }
  }
  return { start, end: start };
}

/**
 * Writes to a temp file beside the target, then renames over it. The result is 0600, or the
 * existing file's mode when that's already 0600 or stricter, unless `fixedMode` says otherwise.
 */
export async function writeFileAtomic(target: string, content: Buffer, fixedMode?: number): Promise<void> {
  let mode = fixedMode ?? 0o600;
  if (fixedMode === undefined) {
    try {
      const existing = await stat(target);
      if ((existing.mode & 0o077) === 0) mode = existing.mode & 0o777;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Last resort after a claim when the target can't be written: the values exist nowhere else.
 * Saved under the user's config directory (never beside the target, which may be in a repo),
 * as `<ISO time>-<target name>-<6 random hex>`, dir 0700, file 0600. The random part keeps two
 * recoveries in the same millisecond apart. Returns the path written.
 */
export async function writeRecoveryFile(
  dir: string,
  targetName: string,
  plaintext: string,
  now: Date = new Date(),
): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  // Colons aren't allowed in Windows file names.
  const path = join(dir, `${now.toISOString().replace(/:/g, "-")}-${targetName}-${randomBytes(3).toString("hex")}`);
  await writeFileAtomic(path, Buffer.from(plaintext, "utf8"));
  return path;
}

export function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
