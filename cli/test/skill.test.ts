import { lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
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
    expect(VERSION).toBe("0.3.0");
    expect(SKILL).not.toContain("{{");
    expect(SKILL.split(VERSION)).toHaveLength(6);
    expect(SKILL).toContain(`npx -y @talix/stubs@${VERSION} pull '<link>' --json`);
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
    expect(help.stdout).toContain("stubs skill install [--target claude|codex] [--force] [--json]");
  });
});
