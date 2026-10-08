import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { isStubsSkill, renderSkill } from "../src/skill";
import { readPackageVersion } from "../src/version";
import { fakeServer } from "./helpers/fake-server";
import { runCli } from "./helpers/run";
import { useTempDirs } from "./helpers/temp";

const tempDir = useTempDirs();
const modes = process.platform !== "win32";
const VERSION = readPackageVersion()!;
const SKILL = renderSkill(VERSION) as string;

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await tempDir();
  cwd = await tempDir();
});

const skill = (args: string[], options: { env?: Record<string, string>; version?: string | null } = {}) =>
  runCli(["skill", ...args], { server: fakeServer(), cwd, home, ...options });
const claudePath = () => join(home, ".claude/skills/stubs/SKILL.md");
const codexPath = () => join(home, ".codex/skills/stubs/SKILL.md");
const exists = (path: string) => stat(path).then(() => true, () => false);

describe("renderSkill", () => {
  it("pins every placeholder to the package version", () => {
    expect(SKILL).not.toContain("{{");
    expect(SKILL.split(VERSION)).toHaveLength(11);
    expect(SKILL).toContain(`npx -y -- @talix/stubs@${VERSION} run -- pnpm test`);
    expect(SKILL).toContain(`npx -y -- @talix/stubs@${VERSION} pull '<link>' --json`);
    expect(isStubsSkill(SKILL)).toBe(true);
  });

  it("refuses to render without a version", () => {
    expect(renderSkill(null)).toMatchObject({ ok: false, code: "error" });
  });
});

describe("isStubsSkill", () => {
  it.each([
    ["---\nname: stubs\ndescription: x\n---\nbody", true],
    ["---\r\ndescription: x\r\nname: 'stubs'\r\n---\r\n", true],
    ["---\nname: other\n---\nname: stubs\n", false],
    ["name: stubs\n", false],
    ["# My notes\n", false],
  ])("reads %j as %s", (text, expected) => {
    expect(isStubsSkill(text)).toBe(expected);
  });
});

describe("stubs skill show", () => {
  it("prints the rendered skill byte for byte, unredacted", async () => {
    const result = await skill(["show"]);
    expect(result).toEqual({ code: 0, stdout: SKILL, stderr: "" });
    expect(result.stdout).toContain("https://stubs.talix.app/t#v1.");
  });

  it("exits 1 when the version can't be read", async () => {
    const result = await skill(["show"], { version: null });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });

  it.each([["show", "--force"], ["show", "x"], ["show", "--json"]])("rejects %j with exit 3", async (...args) => {
    expect((await skill(args)).code).toBe(3);
  });
});

describe("stubs skill install", () => {
  it("installs for Claude Code with 0644 in a 0755 folder", async () => {
    const result = await skill(["install", "--target", "claude"]);
    expect(result).toEqual({
      code: 0,
      stdout: "Installed for Claude Code: ~/.claude/skills/stubs/SKILL.md\n",
      stderr: "",
    });
    expect(await readFile(claudePath(), "utf8")).toBe(SKILL);
    expect(await exists(codexPath())).toBe(false);
    if (modes) {
      expect((await stat(claudePath())).mode & 0o777).toBe(0o644);
      expect((await stat(join(home, ".claude/skills/stubs"))).mode & 0o777).toBe(0o755);
    }
  });

  it("installs for Codex, and for both with --target twice", async () => {
    expect((await skill(["install", "--target", "codex"])).stdout).toBe(
      "Installed for Codex: ~/.codex/skills/stubs/SKILL.md\n",
    );
    const both = await skill(["install", "--target", "claude", "--target", "codex", "--json"]);
    expect(JSON.parse(both.stdout)).toEqual({
      ok: true,
      installed: [
        { target: "claude", path: claudePath(), status: "installed" },
        { target: "codex", path: codexPath(), status: "unchanged" },
      ],
    });
  });

  it("detects which agents are present", async () => {
    await mkdir(join(home, ".claude"));
    const result = await skill(["install"]);
    expect(result.stdout).toBe("Installed for Claude Code: ~/.claude/skills/stubs/SKILL.md\n");
    expect(await exists(join(home, ".codex"))).toBe(false);

    await mkdir(join(home, ".codex"));
    expect((await skill(["install"])).stdout).toBe(
      "Already up to date for Claude Code: ~/.claude/skills/stubs/SKILL.md\nInstalled for Codex: ~/.codex/skills/stubs/SKILL.md\n",
    );
  });

  it("exits 3 when neither agent is present", async () => {
    const result = await skill(["install"]);
    expect(result).toEqual({
      code: 3,
      stdout: "",
      stderr: "stubs: Found neither ~/.claude nor ~/.codex. Pass --target claude or --target codex.\n",
    });
    expect(await readdir(home)).toEqual([]);
  });

  it("leaves an identical file alone", async () => {
    await skill(["install", "--target", "claude"]);
    const before = await stat(claudePath());
    const again = await skill(["install", "--target", "claude", "--json"]);
    expect(JSON.parse(again.stdout).installed[0].status).toBe("unchanged");
    expect((await stat(claudePath())).ino).toBe(before.ino);
  });

  it("updates an older stubs skill", async () => {
    await mkdir(join(home, ".claude/skills/stubs"), { recursive: true });
    await writeFile(claudePath(), "---\nname: stubs\ndescription: old\n---\nnpx -y @talix/stubs@0.1.0 pull\n");
    const result = await skill(["install", "--target", "claude"]);
    expect(result.stdout).toBe("Updated for Claude Code: ~/.claude/skills/stubs/SKILL.md\n");
    expect(await readFile(claudePath(), "utf8")).toBe(SKILL);
  });

  it("refuses a foreign file, touching nothing, unless --force", async () => {
    const foreign = "# my own notes\n";
    await mkdir(join(home, ".claude/skills/stubs"), { recursive: true });
    await writeFile(claudePath(), foreign);
    const refused = await skill(["install", "--target", "codex", "--target", "claude", "--json"]);
    expect(refused.code).toBe(5);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, code: "refused" });
    expect(JSON.parse(refused.stdout).message).toContain("~/.claude/skills/stubs/SKILL.md");
    expect(await readFile(claudePath(), "utf8")).toBe(foreign);
    expect(await exists(codexPath())).toBe(false);

    const forced = await skill(["install", "--target", "claude", "--force"]);
    expect(forced.code).toBe(0);
    expect(await readFile(claudePath(), "utf8")).toBe(SKILL);
  });

  describe("symlinks", () => {
    it("refuses a symlinked skills/stubs folder unless --force, then writes through it", async () => {
      const elsewhere = await tempDir();
      await mkdir(join(home, ".claude/skills"), { recursive: true });
      await symlink(elsewhere, join(home, ".claude/skills/stubs"));
      const refused = await skill(["install", "--target", "claude"]);
      expect(refused).toEqual({
        code: 5,
        stdout: "",
        stderr: "stubs: ~/.claude/skills/stubs is a symlink; pass --force to write through it.\n",
      });
      expect(await readdir(elsewhere)).toEqual([]);

      expect((await skill(["install", "--target", "claude", "--force"])).code).toBe(0);
      expect(await readFile(join(elsewhere, "SKILL.md"), "utf8")).toBe(SKILL);
    });

    it("refuses a symlinked SKILL.md unless --force, which replaces the link and leaves its target", async () => {
      const elsewhere = join(await tempDir(), "notes.md");
      await writeFile(elsewhere, "---\nname: stubs\n---\nold\n");
      await mkdir(join(home, ".claude/skills/stubs"), { recursive: true });
      await symlink(elsewhere, claudePath());
      const refused = await skill(["install", "--target", "claude", "--json"]);
      expect(refused.code).toBe(5);
      expect(JSON.parse(refused.stdout).message).toBe(
        "~/.claude/skills/stubs/SKILL.md is a symlink; pass --force to write through it.",
      );

      expect((await skill(["install", "--target", "claude", "--force"])).code).toBe(0);
      expect((await lstat(claudePath())).isSymbolicLink()).toBe(false);
      expect(await readFile(claudePath(), "utf8")).toBe(SKILL);
      expect(await readFile(elsewhere, "utf8")).toBe("---\nname: stubs\n---\nold\n");
    });

    it("allows a symlinked ~/.claude", async () => {
      const dotfiles = await tempDir();
      await symlink(dotfiles, join(home, ".claude"));
      const result = await skill(["install"]);
      expect(result.stdout).toBe("Installed for Claude Code: ~/.claude/skills/stubs/SKILL.md\n");
      expect(await readFile(join(dotfiles, "skills/stubs/SKILL.md"), "utf8")).toBe(SKILL);
    });

    it("refuses both targets when either is a symlink", async () => {
      await mkdir(join(home, ".codex/skills"), { recursive: true });
      await symlink(await tempDir(), join(home, ".codex/skills/stubs"));
      const result = await skill(["install", "--target", "claude", "--target", "codex"]);
      expect(result.code).toBe(5);
      expect(await exists(join(home, ".claude"))).toBe(false);
    });
  });

  it("honours CODEX_HOME", async () => {
    const codexHome = await tempDir();
    const result = await skill(["install", "--json"], { env: { CODEX_HOME: codexHome } });
    expect(JSON.parse(result.stdout).installed).toEqual([
      { target: "codex", path: join(codexHome, "skills/stubs/SKILL.md"), status: "installed" },
    ]);
    expect(await exists(join(home, ".codex"))).toBe(false);
  });

  it("never touches other files in those folders", async () => {
    await mkdir(join(home, ".claude/skills/stubs"), { recursive: true });
    await mkdir(join(home, ".claude/skills/other"), { recursive: true });
    await writeFile(join(home, ".claude/settings.json"), "{}");
    await writeFile(join(home, ".claude/skills/stubs/notes.md"), "mine");
    await writeFile(join(home, ".claude/skills/other/SKILL.md"), "other");
    await skill(["install", "--target", "claude"]);
    expect((await readdir(join(home, ".claude"))).sort()).toEqual(["settings.json", "skills"]);
    expect((await readdir(join(home, ".claude/skills/stubs"))).sort()).toEqual(["SKILL.md", "notes.md"]);
    expect(await readFile(join(home, ".claude/skills/stubs/notes.md"), "utf8")).toBe("mine");
    expect(await readFile(join(home, ".claude/skills/other/SKILL.md"), "utf8")).toBe("other");
  });

  it("exits 1 without writing when the version can't be read", async () => {
    const result = await skill(["install", "--target", "claude"], { version: null });
    expect(result.code).toBe(1);
    expect(await readdir(home)).toEqual([]);
  });

  it.each([
    [["install", "--target", "cursor"]],
    [["install", "extra"]],
    [["uninstall"]],
    [[]],
  ])("exits 3 for %j", async (args) => {
    expect((await skill(args)).code).toBe(3);
  });

  it("prints skill help", async () => {
    const help = await skill(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("stubs skill install [--target claude|codex] [--force] [--protect] [--json]");
  });
});

describe("stubs skill install --protect", () => {
  const settingsPath = () => join(home, ".claude/settings.json");
  const settings = async () => JSON.parse(await readFile(settingsPath(), "utf8"));
  const RULES = ["Read(.env)", "Read(.env.*)", "Read(~/.config/stubs/**)"];

  it("creates settings.json with the deny rules and says what it added", async () => {
    const result = await skill(["install", "--target", "claude", "--protect"]);
    expect(result).toEqual({
      code: 0,
      stdout:
        "Installed for Claude Code: ~/.claude/skills/stubs/SKILL.md\n" +
        `Claude Code's file tools now deny .env reads: ~/.claude/settings.json (added ${RULES.join(", ")})\n`,
      stderr: "",
    });
    expect(await settings()).toEqual({ permissions: { deny: RULES } });
    if (modes) expect((await stat(settingsPath())).mode & 0o777).toBe(0o644);
  });

  it("appends to existing rules, keeps everything else, and is idempotent", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    const before = { model: "opus", permissions: { allow: ["Bash(git *)"], deny: ["Read(!secrets/public/**)", "Read(.env)", "Bash(rm *)"] }, hooks: {} };
    await writeFile(settingsPath(), JSON.stringify(before));
    await chmod(settingsPath(), 0o600);
    const result = await skill(["install", "--target", "claude", "--protect", "--json"]);
    expect(JSON.parse(result.stdout).protected).toEqual([
      { target: "claude", path: settingsPath(), status: "added", rules: RULES.slice(1) },
    ]);
    expect(await settings()).toEqual({
      ...before,
      permissions: { allow: ["Bash(git *)"], deny: ["Read(!secrets/public/**)", "Read(.env)", "Bash(rm *)", ...RULES.slice(1)] },
    });
    if (modes) expect((await stat(settingsPath())).mode & 0o777).toBe(0o600);

    const again = await skill(["install", "--target", "claude", "--protect"]);
    expect(again.stdout).toBe(
      "Already up to date for Claude Code: ~/.claude/skills/stubs/SKILL.md\n" +
        "Claude Code's file tools already deny .env reads: ~/.claude/settings.json\n",
    );
  });

  it("adds no exception of its own, so a rule the user already has stays as strict as they made it", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(settingsPath(), JSON.stringify({ permissions: { deny: ["Read(.env.*)"] } }));
    const result = await skill(["install", "--target", "claude", "--protect", "--json"]);
    expect(JSON.parse(result.stdout).protected[0]).toMatchObject({ status: "added", rules: ["Read(.env)", RULES[2]] });
    const deny = (await settings()).permissions.deny as string[];
    expect(deny).toEqual(["Read(.env.*)", "Read(.env)", RULES[2]]);
    expect(deny.some((rule) => rule.includes("!"))).toBe(false);
  });

  it.each([
    [["Read(.env.*)", "Read(!.env.local)"], "Read(!.env.local)", "Read(.env.*)"],
    [["Read(.env)", "Read(.env.*)", "Read(~/.config/stubs/**)", "Read(!*.local)"], "Read(!*.local)", "Read(.env) and Read(.env.*) and Read(~/.config/stubs/**)"],
  ])("refuses %j: an exception after a stubs rule may carve into it, so it doesn't report protection", async (deny, exception, undone) => {
    await mkdir(join(home, ".claude"), { recursive: true });
    const content = JSON.stringify({ permissions: { deny } });
    await writeFile(settingsPath(), content);
    const result = await skill(["install", "--target", "claude", "--protect"]);
    expect(result.code).toBe(5);
    expect(result.stderr).toBe(
      `stubs: ~/.claude/settings.json has a Read exception (${exception}) after ${undone}, so the stubs rules don't apply in full. It was left alone: move the exception above them, or install without --protect.\n`,
    );
    expect(await readFile(settingsPath(), "utf8")).toBe(content);
    expect(await exists(claudePath())).toBe(false);
  });

  it("appends after an exception that comes first, which carves nothing out of the stubs rules", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(settingsPath(), JSON.stringify({ permissions: { deny: ["Read(!.env.local)"] } }));
    const result = await skill(["install", "--target", "claude", "--protect", "--json"]);
    expect(JSON.parse(result.stdout).protected[0]).toMatchObject({ status: "added", rules: RULES });
    expect((await settings()).permissions.deny).toEqual(["Read(!.env.local)", ...RULES]);
  });

  it("refuses a settings.json symlink whose target is missing, instead of replacing the link", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    const target = join(await tempDir(), "gone", "settings.json");
    await symlink(target, settingsPath());
    const result = await skill(["install", "--target", "claude", "--protect"]);
    expect(result.code).toBe(5);
    expect(result.stderr).toContain("~/.claude/settings.json is a symlink to a file that doesn't exist, so it was left alone.");
    expect((await lstat(settingsPath())).isSymbolicLink()).toBe(true);
    expect(await exists(target)).toBe(false);
    expect(await exists(claudePath())).toBe(false);
  });

  it("writes through a symlinked settings.json and keeps the link", async () => {
    const dotfiles = join(await tempDir(), "claude-settings.json");
    await writeFile(dotfiles, "{}\n");
    await mkdir(join(home, ".claude"), { recursive: true });
    await symlink(dotfiles, settingsPath());
    const result = await skill(["install", "--target", "claude", "--protect", "--json"]);
    expect(JSON.parse(result.stdout).protected[0]).toMatchObject({ status: "added", path: dotfiles });
    expect((await lstat(settingsPath())).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(dotfiles, "utf8"))).toEqual({ permissions: { deny: RULES } });
  });

  it.each([
    ["{ not json", "isn't valid JSON"],
    ["", "isn't valid JSON"],
    ["[]", "isn't a JSON object"],
    ['{"permissions": "no"}', '"permissions" entry that isn\'t an object'],
    ['{"permissions": null}', '"permissions" entry that isn\'t an object'],
    ['{"permissions": {"deny": {}}}', '"permissions.deny" entry that isn\'t a list of strings'],
    ['{"permissions": {"deny": [42]}}', '"permissions.deny" entry that isn\'t a list of strings'],
  ])("refuses to touch %s, installs nothing, and prints the rules to add by hand", async (content, reason) => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(settingsPath(), content);
    const result = await skill(["install", "--target", "claude", "--protect"]);
    expect(result.code).toBe(5);
    expect(result.stderr).toContain(reason);
    expect(result.stderr).toContain(`Add these to permissions.deny in ~/.claude/settings.json yourself: ${RULES.join(", ")}.`);
    expect(await readFile(settingsPath(), "utf8")).toBe(content);
    expect(await exists(claudePath())).toBe(false);
  });

  it("names the config folder by absolute path when XDG_CONFIG_HOME puts it elsewhere", async () => {
    const xdg = await tempDir();
    const result = await skill(["install", "--target", "claude", "--protect", "--json"], { env: { XDG_CONFIG_HOME: xdg } });
    expect(JSON.parse(result.stdout).protected[0].rules).toContain(`Read(/${xdg}/stubs/**)`);
  });

  it("honours CLAUDE_CONFIG_DIR for the skill and the settings", async () => {
    const configDir = await tempDir();
    const result = await skill(["install", "--target", "claude", "--protect", "--json"], { env: { CLAUDE_CONFIG_DIR: configDir } });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.installed).toEqual([{ target: "claude", path: join(configDir, "skills/stubs/SKILL.md"), status: "installed" }]);
    expect(parsed.protected[0]).toMatchObject({ path: join(configDir, "settings.json"), status: "added" });
    expect(await exists(join(home, ".claude"))).toBe(false);
  });

  it("reports that Codex has no equivalent", async () => {
    const result = await skill(["install", "--target", "codex", "--protect"]);
    expect(result.stdout).toBe(
      "Installed for Codex: ~/.codex/skills/stubs/SKILL.md\nCodex: no deny rule installed; it has no equivalent setting (see the README).\n",
    );
    expect(await exists(settingsPath())).toBe(false);
  });

  it("is refused by skill show", async () => {
    expect((await skill(["show", "--protect"])).code).toBe(3);
  });
});
