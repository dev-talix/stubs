// Refuses to write secrets into a file git would pick up. Facts come from git itself; the
// decision is a pure function so the table is easy to test. When git can't answer, the guard
// fails closed inside anything that looks like a repository.

import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type GitFacts =
  | { kind: "no_repo" }
  | { kind: "repo"; ignored: boolean; tracked: boolean }
  /** Possibly in a repo, but git couldn't say whether the file is ignored. */
  | { kind: "unknown" };

export type GuardDecision =
  | { kind: "allow" }
  | { kind: "refuse"; reason: "tracked" | "not_ignored" | "unknown" };

export function decideGuard(facts: GitFacts, allowTracked: boolean): GuardDecision {
  if (allowTracked || facts.kind === "no_repo") return { kind: "allow" };
  if (facts.kind === "unknown") return { kind: "refuse", reason: "unknown" };
  if (facts.tracked) return { kind: "refuse", reason: "tracked" };
  if (!facts.ignored) return { kind: "refuse", reason: "not_ignored" };
  return { kind: "allow" };
}

/** The refusal, naming exactly what to add to .gitignore. */
export function guardMessage(reason: "tracked" | "not_ignored" | "unknown", file: string): string {
  const entry = basename(file);
  const nothing = "Nothing was consumed.";
  switch (reason) {
    case "tracked":
      return `${file} is tracked by git. Run \`git rm --cached ${file}\`, add \`${entry}\` to .gitignore, then pull again (or pass --allow-tracked). ${nothing}`;
    case "not_ignored":
      return `${file} isn't ignored by git. Add \`${entry}\` to .gitignore, then pull again (or pass --allow-tracked). ${nothing}`;
    case "unknown":
      return `Couldn't ask git whether ${file} is ignored; refusing to write inside a repository. Pass --allow-tracked to override.`;
  }
}

/** Exit code, or "failed" when git couldn't run at all (missing, timed out, killed). */
export type GitRun = { code: number | "failed"; stdout: string; stderr: string };
export type GitRunner = (args: string[], cwd: string) => Promise<GitRun>;

export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    // LC_ALL=C keeps the "not a git repository" text matchable.
    execFile("git", args, { cwd, timeout: 10_000, env: { ...process.env, LC_ALL: "C" } }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      resolve({ code: typeof error.code === "number" ? error.code : "failed", stdout, stderr });
    });
  });

/** Asks git about an absolute, already resolved path. Its directory must exist. */
export async function probeGit(file: string, git: GitRunner = runGit): Promise<GitFacts> {
  const cwd = dirname(file);
  const name = basename(file);
  const inside = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    // Only git's own clear answer counts as "not a repo"; anything else falls back to looking.
    if (inside.code === 128 && /not a git repository/i.test(inside.stderr)) return { kind: "no_repo" };
    return (await hasGitAbove(cwd)) ? { kind: "unknown" } : { kind: "no_repo" };
  }

  const tracked = await git(["ls-files", "--error-unmatch", "--", name], cwd);
  if (tracked.code === 0) return { kind: "repo", ignored: false, tracked: true };
  if (tracked.code !== 1) return { kind: "unknown" };

  const ignored = await git(["check-ignore", "-q", "--", name], cwd);
  if (ignored.code === 0) return { kind: "repo", ignored: true, tracked: false };
  if (ignored.code === 1) return { kind: "repo", ignored: false, tracked: false };
  return { kind: "unknown" };
}

/** Whether `dir` or any parent holds a `.git` entry (a directory, or a file for worktrees). */
async function hasGitAbove(dir: string): Promise<boolean> {
  for (let current = dir; ; current = dirname(current)) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch {
      // Keep walking.
    }
    if (dirname(current) === current) return false;
  }
}
