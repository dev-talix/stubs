// The agent skill: SKILL.md bundled into the binary, pinned to this version, and installed for
// Claude Code and Codex. Installing only ever writes `skills/stubs/SKILL.md` under each tool's
// home, and never replaces a file that isn't a stubs skill without --force.

import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import template from "../skill/SKILL.md?raw";
import { isNotFound, writeFileAtomic } from "./env-file";
import { configDir } from "./identity";
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
  /** With --protect: what each tool now denies. */
  protected?: ProtectResult[];
}

export type ProtectResult =
  /** `rules` are the ones added this time; "unchanged" means every rule was already there. */
  | { target: "claude"; path: string; status: "added" | "unchanged"; rules: string[] }
  | { target: "codex"; status: "unsupported" };

/**
 * Claude Code permission rules that deny reading `.env` and `.env.*` files (any depth under
 * the project) and the stubs config folder. `.env*` would also catch `.envrc` and the like.
 * A Read deny also covers Edit and Write, and the file commands Claude Code recognises in
 * Bash (cat, head, tail, sed, tee) and redirections. No `!` exceptions for `.env.example` and
 * `.env.sample`: an exception relaxes every rule listed before it, including ones the user
 * wrote, so adding one could reopen a file they had denied.
 */
export function claudeDenyRules(deps: Pick<SkillDeps, "home" | "env">): string[] {
  const config = configDir(deps);
  const home = deps.home.replace(/\/+$/, "");
  const configRule = config.startsWith(home + "/") ? `~${config.slice(home.length)}/**` : `/${config}/**`;
  return ["Read(.env)", "Read(.env.*)", `Read(${configRule})`];
}

/** A deny rule that carves paths out of the rules listed before it. */
const isException = (rule: unknown) => typeof rule === "string" && /^Read\(\s*!/.test(rule);

interface SettingsPlan {
  path: string;
  content: Buffer | null;
  mode: number;
  added: string[];
}

/**
 * Reads ~/.claude/settings.json (through a symlink, so a dotfiles setup keeps its link) and
 * works out the file with the rules appended to `permissions.deny`. Anything else in the
 * file is kept as parsed; a file that can't be read as that shape is refused, never rewritten.
 */
async function planClaudeSettings(deps: SkillDeps): Promise<SettingsPlan | Failure> {
  const rules = claudeDenyRules(deps);
  const linkPath = join(toolHome("claude", deps), "settings.json");
  const shown = tildePath(linkPath, deps.home);
  const byHand = `Add these to permissions.deny in ${shown} yourself: ${rules.join(", ")}.`;
  let path = linkPath;
  let existing: string | null;
  let mode = 0o644;
  try {
    path = await realpath(linkPath);
    existing = await readFile(path, "utf8");
    mode = (await stat(path)).mode & 0o777;
  } catch (error) {
    if (!isNotFound(error)) return fail("error", `Couldn't read ${shown} (${errorCode(error)}).`);
    // realpath fails the same way for a missing file and for a link to a missing file. Writing
    // through the second would replace the link with a plain file.
    if (await lstat(linkPath).then((entry) => entry.isSymbolicLink(), () => false)) {
      return fail("refused", `${shown} is a symlink to a file that doesn't exist, so it was left alone. ${byHand}`);
    }
    existing = null;
  }

  let settings: Record<string, unknown> = {};
  if (existing !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      return fail("refused", `${shown} isn't valid JSON, so it was left alone. ${byHand}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return fail("refused", `${shown} isn't a JSON object, so it was left alone. ${byHand}`);
    }
    settings = parsed as Record<string, unknown>;
  }
  const permissions = "permissions" in settings ? settings.permissions : {};
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return fail("refused", `${shown} has a "permissions" entry that isn't an object, so it was left alone. ${byHand}`);
  }
  const deny: unknown = "deny" in permissions ? (permissions as Record<string, unknown>).deny : [];
  if (!Array.isArray(deny) || !deny.every((rule) => typeof rule === "string")) {
    return fail("refused", `${shown} has a "permissions.deny" entry that isn't a list of strings, so it was left alone. ${byHand}`);
  }
  // Rules are ordered: a `Read(!...)` exception carves paths out of the rules before it. A
  // stubs rule only counts when nothing after it can carve into it, so a rule the user wrote
  // an exception for (their `Read(.env.*)` then `Read(!.env.local)`) isn't taken as done.
  // Adding it again after the exception would quietly undo their choice, so that's refused.
  const lastException = deny.findLastIndex(isException);
  const undone = rules.filter((rule) => deny.includes(rule) && deny.lastIndexOf(rule) < lastException);
  if (undone.length > 0) {
    return fail(
      "refused",
      `${shown} has a Read exception (${deny[lastException]}) after ${undone.join(" and ")}, so the stubs rules don't apply in full. It was left alone: move the exception above them, or install without --protect.`,
    );
  }
  const added = rules.filter((rule) => !deny.includes(rule));
  if (added.length === 0) return { path, content: null, mode, added };
  settings.permissions = { ...permissions, deny: [...deny, ...added] };
  return { path, content: Buffer.from(`${JSON.stringify(settings, null, 2)}\n`, "utf8"), mode, added };
}

/** `$CLAUDE_CONFIG_DIR` (default `~/.claude`), or `$CODEX_HOME` (default `~/.codex`). */
export function toolHome(target: SkillTarget, deps: Pick<SkillDeps, "home" | "cwd" | "env">): string {
  const configured = target === "claude" ? deps.env.CLAUDE_CONFIG_DIR : deps.env.CODEX_HOME;
  if (configured) return resolve(deps.cwd, configured);
  return join(deps.home, target === "claude" ? ".claude" : ".codex");
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
  options: { targets: SkillTarget[]; force?: boolean; protect?: boolean },
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

  // Settings are planned before anything is written too, so a refusal here changes nothing.
  let settings: SettingsPlan | undefined;
  if (options.protect && targets.includes("claude")) {
    const planned = await planClaudeSettings(deps);
    if ("ok" in planned) return planned;
    settings = planned;
  }

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
  if (!options.protect) return { ok: true, installed: plans };

  const protectedTargets: ProtectResult[] = [];
  for (const target of targets) {
    if (target === "codex") {
      protectedTargets.push({ target, status: "unsupported" });
      continue;
    }
    const plan = settings!;
    if (plan.content !== null) {
      try {
        await mkdir(dirname(plan.path), { recursive: true, mode: 0o755 });
        await writeFileAtomic(plan.path, plan.content, plan.mode);
      } catch (error) {
        return fail("error", `Couldn't write ${tildePath(plan.path, deps.home)} (${errorCode(error)}).`);
      }
    }
    protectedTargets.push({ target, path: plan.path, status: plan.content === null ? "unchanged" : "added", rules: plan.added });
  }
  return { ok: true, installed: plans, protected: protectedTargets };
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
