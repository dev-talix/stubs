import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pairsOf, parseDotenv } from "../../src/core/dotenv";
import { formatValue, looksLikeExpansion, mergeEnv, writeFileAtomic, writeRecoveryFile } from "../src/env-file";
import { useTempDirs } from "./helpers/temp";

const tempDir = useTempDirs();
const text = (buffer: Buffer | null) => buffer?.toString("utf8") ?? null;

describe("formatValue", () => {
  it.each([
    ["plain", "plain"],
    ["", ""],
    ["postgres://u:p@h:5432/db?x=1", "postgres://u:p@h:5432/db?x=1"],
    ["back\\slash", "'back\\slash'"],
    ["two words", "'two words'"],
    ["a#b", "'a#b'"],
    ['say "hi"', `'say "hi"'`],
    ["it's", "`it's`"],
    ["it's `quoted`", `"it's \`quoted\`"`.replace("\\`", "`").replace("\\`", "`")],
    ["$HOME/x", "'$HOME/x'"],
    ['{"a":1}', `'{"a":1}'`],
    ["line1\nline2", '"line1\\nline2"'],
    ["tab\there", "'tab\there'"],
    [" padded ", "' padded '"],
    ["c:\\path with space", "'c:\\path with space'"],
  ])("formats %j as %s", (value, formatted) => {
    expect(formatValue(value)).toBe(formatted);
  });

  it.each([
    "two words", 'q"uote', "x\ny", "x\r\ny", "\\n literal", "a # b", "`tick`", "'single'", " ", "é ü",
    "it's `both`", "all 'three' \"kinds\" `here`", "$VAR", '{"json":"value"}', "multi\nwith 'q'",
  ])(
    "round-trips %j through parseDotenv",
    (value) => {
      const [pair] = pairsOf(parseDotenv(`KEY=${formatValue(value)}`));
      expect(pair?.value).toBe(value);
    },
  );
});

describe("mergeEnv", () => {
  it("creates content when there's no file", () => {
    const plan = mergeEnv(null, "A=1\nB=two words\n", false);
    expect(plan).toMatchObject({ written: ["A", "B"], skipped: [], unparsed: 0 });
    expect(text(plan.content)).toBe("A=1\nB='two words'\n");
  });

  it("preserves existing bytes exactly and appends after them", () => {
    const existing = Buffer.from("# keep me\nexport OLD = 'x'  \n\n\tWEIRD=1 # comment", "utf8");
    const plan = mergeEnv(existing, "NEW=1", false);
    expect(plan.content!.subarray(0, existing.length).equals(existing)).toBe(true);
    expect(text(plan.content)).toBe(existing.toString() + "\nNEW=1\n");
  });

  it("keeps bytes that aren't valid UTF-8 when only appending", () => {
    const existing = Buffer.concat([Buffer.from("A=1\nB="), Buffer.from([0xff, 0xfe]), Buffer.from("\n")]);
    const plan = mergeEnv(existing, "C=3", false);
    expect(plan.content!.subarray(0, existing.length).equals(existing)).toBe(true);
  });

  it("uses CRLF when the existing file does", () => {
    const plan = mergeEnv(Buffer.from("A=1\r\nB=2\r\n"), "C=3\nD=4", false);
    expect(text(plan.content)).toBe("A=1\r\nB=2\r\nC=3\r\nD=4\r\n");
  });

  it("reads CRLF input from the stub", () => {
    const plan = mergeEnv(null, "A=1\r\nB=2\r\n", false);
    expect(plan.written).toEqual(["A", "B"]);
    expect(text(plan.content)).toBe("A=1\nB=2\n");
  });

  it("skips keys that already exist, changed or not", () => {
    const existing = Buffer.from("PORT=3000\nSAME=1\n");
    const plan = mergeEnv(existing, "PORT=4000\nSAME=1\nNEW=x", false);
    expect(plan).toMatchObject({ written: ["NEW"], skipped: ["PORT", "SAME"] });
    expect(text(plan.content)).toBe(
      "PORT=3000\nSAME=1\nNEW=x\n# stubs skipped (already set): PORT=4000\n# stubs skipped (already set): SAME=1\n",
    );
  });

  it("returns no content when nothing changes", () => {
    const plan = mergeEnv(Buffer.from("A=1\n"), "A=1", true);
    expect(plan).toEqual({ content: null, written: [], skipped: ["A"], held: [], unparsed: 0, malformedLines: [] });
  });

  it("overwrites changed values in place and leaves everything else alone", () => {
    const existing = Buffer.from('# top\nPORT=3000 # dev\nMULTI="a\nb"\nKEEP=1\nSAME=s');
    const plan = mergeEnv(existing, "PORT=4000\nMULTI=one line\nSAME=s\nNEW=n", true);
    expect(plan).toMatchObject({ written: ["PORT", "MULTI", "NEW"], skipped: ["SAME"] });
    expect(text(plan.content)).toBe("# top\nPORT=4000\nMULTI='one line'\nKEEP=1\nSAME=s\nNEW=n\n");
  });

  it("overwrites every duplicate of a key, keeping CRLF", () => {
    const plan = mergeEnv(Buffer.from("A=1\r\nB=2\r\nA=3\r\n"), "A=new", true);
    expect(text(plan.content)).toBe("A=new\r\nB=2\r\nA=new\r\n");
  });

  it("lets a later duplicate in the stub win", () => {
    const plan = mergeEnv(null, "A=1\nA=2", false);
    expect(plan.written).toEqual(["A"]);
    expect(text(plan.content)).toBe("A=2\n");
  });

  it("appends unparsed lines as comments so nothing is lost", () => {
    const plan = mergeEnv(Buffer.from("X=1\n"), "# a comment\n\nA=1\nnot a pair\n  1BAD=2  \n", false);
    expect(plan).toMatchObject({ written: ["A"], unparsed: 2 });
    expect(text(plan.content)).toBe("X=1\nA=1\n# unparsed: not a pair\n# unparsed: 1BAD=2\n");
  });
});

describe("writeFileAtomic", () => {
  it("creates new files 0600 and leaves no temp files", async () => {
    const dir = await tempDir();
    const file = join(dir, ".env.local");
    await writeFileAtomic(file, Buffer.from("A=1\n"));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe("A=1\n");
    expect(await readdir(dir)).toEqual([".env.local"]);
  });

  it("tightens a loose mode to 0600 and keeps a stricter one", async () => {
    const dir = await tempDir();
    const loose = join(dir, "loose");
    const strict = join(dir, "strict");
    await writeFile(loose, "");
    await chmod(loose, 0o644);
    await writeFile(strict, "");
    await chmod(strict, 0o400);
    await writeFileAtomic(loose, Buffer.from("x"));
    await writeFileAtomic(strict, Buffer.from("x"));
    expect((await stat(loose)).mode & 0o777).toBe(0o600);
    expect((await stat(strict)).mode & 0o777).toBe(0o400);
  });
});

describe("writeRecoveryFile", () => {
  it("writes <ISO time>-<name> with dir 0700 and file 0600, never clobbering", async () => {
    const dir = join(await tempDir(), "stubs", "recovered");
    const now = new Date("2026-10-05T12:34:56.789Z");
    const first = await writeRecoveryFile(dir, ".env.local", "A=1", now);
    const second = await writeRecoveryFile(dir, ".env.local", "A=2", new Date(now.getTime() + 1));
    expect(first.startsWith(join(dir, "2026-10-05T12-34-56.789Z-.env.local-"))).toBe(true);
    expect(first).toMatch(/-[0-9a-f]{6}$/);
    expect(second).not.toBe(first);
    expect(await readFile(first, "utf8")).toBe("A=1");
    expect(await readFile(second, "utf8")).toBe("A=2");
    expect((await stat(first)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("writeRecoveryFile collisions", () => {
  it("keeps two recoveries made in the same millisecond", async () => {
    const dir = join(await tempDir(), "recovered");
    const frozen = new Date("2026-10-05T12:34:56.789Z");
    const first = await writeRecoveryFile(dir, ".env.local", "A=1", frozen);
    const second = await writeRecoveryFile(dir, ".env.local", "A=2", frozen);
    expect(second).not.toBe(first);
    expect((await readdir(dir)).sort()).toHaveLength(2);
    expect(await readFile(first, "utf8")).toBe("A=1");
    expect(await readFile(second, "utf8")).toBe("A=2");
  });
});

describe("writeFileAtomic failures", () => {
  it("removes its temp file when the rename fails", async () => {
    const dir = await tempDir();
    // Renaming a file over a non-empty directory fails after the temp file is written.
    await mkdir(join(dir, "target", "inside"), { recursive: true });
    await expect(writeFileAtomic(join(dir, "target"), Buffer.from("A=1"))).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["target"]);
  });
});

describe("mergeEnv review fixes", () => {
  it("keeps a skipped key's pulled value in a comment after the new keys", () => {
    const plan = mergeEnv(Buffer.from("PORT=3000\n"), "PORT=4000 x\nNEW=1\nodd line", false);
    expect(plan).toMatchObject({ written: ["NEW"], skipped: ["PORT"], unparsed: 1 });
    expect(text(plan.content)).toBe(
      "PORT=3000\nNEW=1\n# stubs skipped (already set): PORT='4000 x'\n# unparsed: odd line\n",
    );
  });

  it("adds no skipped comment with --overwrite", () => {
    const plan = mergeEnv(Buffer.from("PORT=3000\nSAME=1\n"), "PORT=4000\nSAME=1", true);
    expect(text(plan.content)).toBe("PORT=4000\nSAME=1\n");
  });

  it("writes a skipped comment even when only skipped keys arrive", () => {
    const plan = mergeEnv(Buffer.from("A=1\n"), "A=2", false);
    expect(plan.written).toEqual([]);
    expect(text(plan.content)).toBe("A=1\n# stubs skipped (already set): A=2\n");
  });

  it("keeps invalid UTF-8 on other lines byte for byte under --overwrite", () => {
    const bad = Buffer.from([0x4f, 0x4c, 0x44, 0x3d, 0xff, 0xfe, 0xc3]); // OLD=<invalid bytes>
    const existing = Buffer.concat([Buffer.from("A=1\r\n"), bad, Buffer.from("\r\nB=2\r\n")]);
    const plan = mergeEnv(existing, "A=new\nB=2", true);
    expect(plan.content).toEqual(Buffer.concat([Buffer.from("A=new\r\n"), bad, Buffer.from("\r\nB=2\r\n")]));
  });

  it("reports malformed lines in the existing file", () => {
    const plan = mergeEnv(Buffer.from('A=1\nB="unclosed\nC=3\n'), "D=4", false);
    expect(plan.malformedLines).toEqual([2]);
    expect(text(plan.content)).toBe('A=1\nB="unclosed\nC=3\nD=4\n');
  });
});

describe("mergeEnv holds back $ references", () => {
  it.each(["$PRIVATE_KEY", "${PRIVATE_KEY}", "https://$HOST/x", "pa$$word", "a${b"])("holds back %j", (value) => {
    expect(looksLikeExpansion(value)).toBe(true);
  });

  it.each(["plain", "5$", "$1", "$$", "cost: $ 5", "100$."])("writes %j live", (value) => {
    expect(looksLikeExpansion(value)).toBe(false);
  });

  it("keeps a referencing value as a comment instead of a live line", () => {
    const existing = Buffer.from("PRIVATE_KEY=sk-live\n");
    const plan = mergeEnv(existing, "PUBLIC_X=$PRIVATE_KEY\nOK=1", false);
    expect(plan).toMatchObject({ written: ["OK"], skipped: [], held: ["PUBLIC_X"] });
    expect(text(plan.content)).toBe("PRIVATE_KEY=sk-live\nOK=1\n# stubs held back ($ reference): PUBLIC_X='$PRIVATE_KEY'\n");
    // Nothing a dotenv-expand consumer would act on.
    expect(pairsOf(parseDotenv(text(plan.content)!)).map((p) => p.key)).toEqual(["PRIVATE_KEY", "OK"]);
  });

  it("does not overwrite an existing key with a referencing value", () => {
    const plan = mergeEnv(Buffer.from("API_URL=https://real.example\n"), "API_URL=https://$EVIL/x", true);
    expect(plan).toMatchObject({ written: [], held: ["API_URL"] });
    expect(text(plan.content)).toBe(
      "API_URL=https://real.example\n# stubs held back ($ reference): API_URL='https://$EVIL/x'\n",
    );
  });

  it("reports held before unparsed and after skipped comments", () => {
    const plan = mergeEnv(Buffer.from("A=1\n"), "A=2\nB=$A\nnot a pair", false);
    expect(text(plan.content)).toBe(
      "A=1\n# stubs skipped (already set): A=2\n# stubs held back ($ reference): B='$A'\n# unparsed: not a pair\n",
    );
    expect(plan).toMatchObject({ written: [], skipped: ["A"], held: ["B"], unparsed: 1 });
  });
});
