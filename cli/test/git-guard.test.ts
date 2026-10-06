import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { decideGuard, guardMessage, probeGit, type GitFacts } from "../src/git-guard";
import { useTempDirs } from "./helpers/temp";

const exec = promisify(execFile);
const tempDir = useTempDirs();

describe("decideGuard", () => {
  const table: [string, GitFacts, boolean, string][] = [
    ["not a repo", { kind: "no_repo" }, false, "allow"],
    ["ignored", { kind: "repo", ignored: true, tracked: false }, false, "allow"],
    ["untracked, not ignored", { kind: "repo", ignored: false, tracked: false }, false, "not_ignored"],
    ["tracked", { kind: "repo", ignored: false, tracked: true }, false, "tracked"],
    ["unknown", { kind: "unknown" }, false, "unknown"],
    ["tracked with --allow-tracked", { kind: "repo", ignored: false, tracked: true }, true, "allow"],
    ["not ignored with --allow-tracked", { kind: "repo", ignored: false, tracked: false }, true, "allow"],
    ["unknown with --allow-tracked", { kind: "unknown" }, true, "allow"],
  ];
  it.each(table)("%s", (_, facts, allowTracked, expected) => {
    const decision = decideGuard(facts, allowTracked);
    expect(decision.kind === "allow" ? "allow" : decision.reason).toBe(expected);
  });

  it("names exactly what to add to .gitignore", () => {
    expect(guardMessage("not_ignored", "config/.env.local")).toContain("Add `.env.local` to .gitignore");
    expect(guardMessage("tracked", ".env")).toContain("git rm --cached .env");
    expect(guardMessage("not_ignored", ".env.local", "shared/real.env")).toContain(
      ".env.local points at shared/real.env, which git would track. Add `shared/real.env`",
    );
  });
});

describe("probeGit", () => {
  async function repo() {
    const dir = await tempDir();
    await exec("git", ["init", "-q"], { cwd: dir });
    await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    await exec("git", ["config", "user.name", "t"], { cwd: dir });
    return dir;
  }

  it("sees no repo in a plain directory", async () => {
    expect(await probeGit(join(await tempDir(), ".env.local"))).toEqual({ kind: "no_repo" });
  });

  it("sees an ignored file, including one that doesn't exist yet", async () => {
    const dir = await repo();
    await writeFile(join(dir, ".gitignore"), ".env*.local\n");
    await mkdir(join(dir, "app"));
    expect(await probeGit(join(dir, ".env.local"))).toEqual({ kind: "repo", ignored: true, tracked: false, root: dir });
    expect(await probeGit(join(dir, "app", ".env.local"))).toEqual({
      kind: "repo",
      ignored: true,
      tracked: false,
      root: dir,
    });
  });

  it("sees a file that isn't ignored", async () => {
    const dir = await repo();
    expect(await probeGit(join(dir, ".env.local"))).toEqual({ kind: "repo", ignored: false, tracked: false, root: dir });
  });

  it("sees a tracked file even when .gitignore matches it", async () => {
    const dir = await repo();
    await writeFile(join(dir, ".env"), "A=1\n");
    await exec("git", ["add", ".env"], { cwd: dir });
    await exec("git", ["commit", "-qm", "oops"], { cwd: dir });
    await writeFile(join(dir, ".gitignore"), ".env\n");
    expect(await probeGit(join(dir, ".env"))).toEqual({ kind: "repo", ignored: false, tracked: true, root: dir });
  });
});
