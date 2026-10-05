import { describe, expect, it } from "vitest";
import { parseDotenv } from "../../src/client/dotenv";

const pairs = (source: string) =>
  parseDotenv(source).flatMap((line) => (line.kind === "pair" ? [[line.key, line.value]] : []));

describe("parseDotenv", () => {
  it("reads plain pairs and skips comments and blanks", () => {
    expect(pairs("# db\nA=1\n\nB = two words \n")).toEqual([
      ["A", "1"],
      ["B", "two words"],
    ]);
  });

  it("keeps = inside values and allows empty values", () => {
    expect(pairs("URL=postgres://h/db?ssl=true\nEMPTY=")).toEqual([
      ["URL", "postgres://h/db?ssl=true"],
      ["EMPTY", ""],
    ]);
  });

  it("strips export and inline comments on unquoted values only", () => {
    expect(pairs('export A=1 # note\nB="x # not a comment"\nC=a#b')).toEqual([
      ["A", "1"],
      ["B", "x # not a comment"],
      ["C", "a#b"],
    ]);
  });

  it("handles quotes, escapes, and multi-line values", () => {
    expect(pairs("S='single \\n raw'\nD=\"a\\nb \\\"q\\\"\"\nK=\"-----BEGIN\nabc\n-----END\"\nNEXT=1")).toEqual([
      ["S", "single \\n raw"],
      ["D", 'a\nb "q"'],
      ["K", "-----BEGIN\nabc\n-----END"],
      ["NEXT", "1"],
    ]);
  });

  it("expands \\r and \\t escapes in double quotes", () => {
    expect(pairs('CRLF="a\\r\\nb"\nTAB="x\\ty"')).toEqual([
      ["CRLF", "a\r\nb"],
      ["TAB", "x\ty"],
    ]);
  });

  it("flags lines it can't read, with their line numbers", () => {
    const lines = parseDotenv("A=1\nnot a pair\n1BAD=x\nC=\"unterminated");
    expect(lines.filter((l) => l.kind === "invalid").map((l) => l.line)).toEqual([2, 3, 4]);
  });

  it("doesn't let an unclosed quote swallow the lines after it", () => {
    const lines = parseDotenv('A="open\nB=2\nC=3');
    expect(lines.map((l) => l.kind)).toEqual(["invalid", "pair", "pair"]);
  });

  it("accepts Windows line endings", () => {
    expect(pairs("A=1\r\nB=2\r\n")).toEqual([
      ["A", "1"],
      ["B", "2"],
    ]);
  });
});
