// The agent skill: SKILL.md bundled into the binary, pinned to this version, and installed for
// Claude Code and Codex. Installing only ever writes `skills/stubs/SKILL.md` under each tool's
// home, and never replaces a file that isn't a stubs skill without --force.

import { lstat, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import template from "../skill/SKILL.md?raw";
import { isNotFound, writeFileAtomic } from "./env-file";
import { errorCode, fail, type Failure } from "./result";

export const SKILL_TARGETS = ["claude", "codex"] as const;
export type SkillTarget = (typeof SKILL_TARGETS)[number];

const LABELS: Record<SkillTarget, string> = { claude: "Claude Code", codex: "Codex" };

export function isSkillTarget(value: string): value is SkillTarget {
  return SKILL_TARGETS.some((target) => target === value);
}

export function targetLabel(target: SkillTarget): string {
  return LABELS[target];
}

/** The skill with every `{{VERSION}}` pinned, or a failure when the version is unknown. */
export function renderSkill(version: string | null): string | Failure {
  if (!version) {
    return fail("error", "Couldn't read this package's version, so the skill can't be pinned. Reinstall @talix/stubs.");
  }
  return template.replaceAll("{{VERSION}}", version);
}

export interface SkillDeps {
  home: string;
  cwd: string;
  env: Record<string, string | undefined>;
  version: string | null;
}

export type InstallStatus = "installed" | "updated" | "unchanged";
export interface InstallSuccess {
  ok: true;
  installed: { target: SkillTarget; path: string; status: InstallStatus }[];
}

/** `~/.claude`, or `$CODEX_HOME` (default `~/.codex`). */
export function toolHome(target: SkillTarget, deps: Pick<SkillDeps, "home" | "cwd" | "env">): string {
  if (target === "claude") return join(deps.home, ".claude");
  const codexHome = deps.env.CODEX_HOME;
  return codexHome ? resolve(deps.cwd, codexHome) : join(deps.home, ".codex");
}

export function skillPath(target: SkillTarget, deps: Pick<SkillDeps, "home" | "cwd" | "env">): string {
  return join(toolHome(target, deps), "skills", "stubs", "SKILL.md");
}

/** Shows paths under home as `~/...`. */
export function tildePath(path: string, home: string): string {
  return path === home || path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

/** Whether a file is some version of this skill: its frontmatter says `name: stubs`. */
export function isStubsSkill(text: string): boolean {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return false;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") return false;
    if (/^name:\s*(["']?)stubs\1\s*$/.test(line)) return true;
  }
  return false;
}

export async function installSkill(
  options: { targets: SkillTarget[]; force?: boolean },
  deps: SkillDeps,
): Promise<InstallSuccess | Failure> {
  const rendered = renderSkill(deps.version);
  if (typeof rendered !== "string") return rendered;
  const content = Buffer.from(rendered, "utf8");

  const explicit = options.targets.length > 0;
  const targets = explicit ? [...new Set(options.targets)] : await detectTargets(deps);
  if (targets.length === 0) {
    return fail("invalid", "Found neither ~/.claude nor ~/.codex. Pass --target claude or --target codex.");
  }

  // Decide everything before writing anything, so a refusal leaves every tool untouched.
  const plans: { target: SkillTarget; path: string; status: InstallStatus }[] = [];
  const refused: string[] = [];
  for (const target of targets) {
    const path = skillPath(target, deps);
    // A symlinked `skills/stubs` or SKILL.md would send the write somewhere else entirely.
    // Symlinks above `skills/stubs` (a dotfile-managed ~/.claude) are fine.
    if (!options.force) {
      const linked = await firstSymlink([dirname(path), path]);
      if (linked) {
        refused.push(`${tildePath(linked, deps.home)} is a symlink; pass --force to write through it.`);
        continue;
      }
    }
    let existing: Buffer | null;
    try {
      existing = await readFile(path);
    } catch (error) {
      if (!isNotFound(error)) return fail("error", `Couldn't read ${tildePath(path, deps.home)} (${errorCode(error)}).`);
      existing = null;
    }
    if (existing === null) plans.push({ target, path, status: "installed" });
    else if (existing.equals(content)) plans.push({ target, path, status: "unchanged" });
    else if (isStubsSkill(existing.toString("utf8"))) plans.push({ target, path, status: "updated" });
    else if (options.force) plans.push({ target, path, status: "installed" });
    else {
      refused.push(
        `${tildePath(path, deps.home)} already exists and isn't a stubs skill. Move it aside, or pass --force to replace it.`,
      );
    }
  }
  if (refused.length > 0) return fail("refused", refused.join(" "));

  for (const plan of plans) {
    if (plan.status === "unchanged") continue;
    try {
      const dir = join(toolHome(plan.target, deps), "skills", "stubs");
      await mkdir(dir, { recursive: true, mode: 0o755 });
      await writeFileAtomic(plan.path, content, 0o644);
    } catch (error) {
      return fail("error", `Couldn't write ${tildePath(plan.path, deps.home)} (${errorCode(error)}).`);
    }
  }
  return { ok: true, installed: plans };
}

async function firstSymlink(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    if (await lstat(path).then((entry) => entry.isSymbolicLink(), () => false)) return path;
  }
  return null;
}

async function detectTargets(deps: SkillDeps): Promise<SkillTarget[]> {
  const found: SkillTarget[] = [];
  for (const target of SKILL_TARGETS) {
    const home = toolHome(target, deps);
    if (await stat(home).then((entry) => entry.isDirectory(), () => false)) found.push(target);
  }
  return found;
}
