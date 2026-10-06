import { describe, expect, it } from "vitest";
import { exitCodeForResult } from "../src/cli";
import { exitCodeFor, fail, type FailureCode } from "../src/result";

describe("exit codes", () => {
  it.each<[FailureCode, number]>([
    ["void", 2],
    ["invalid", 3],
    ["network", 4],
    ["refused", 5],
    ["tampered", 6],
    ["uncertain", 7],
    ["error", 1],
  ])("%s exits %i", (code, exit) => {
    expect(exitCodeFor(fail(code, "x"))).toBe(exit);
  });

  it("exits 0 on success", () => {
    expect(exitCodeFor({ ok: true })).toBe(0);
    expect(exitCodeForResult({ ok: true, file: ".env.local", written: [], skipped: [], unparsed: 0, warnings: [] })).toBe(0);
    expect(exitCodeForResult({ ok: true, status: "sealed", expiresAt: 1 })).toBe(0);
  });

  it("exits 2 when check finds the stub void", () => {
    expect(exitCodeForResult({ ok: true, status: "void" })).toBe(2);
  });
});
