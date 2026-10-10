/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STUBS_CLI_VERSION } from "../../src/shared/stubs-cli";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

// Markdown that GitHub and npm render as-is, so it has to carry the literal version.
// `pnpm sync-version` rewrites it; this test catches a bump that skipped that step.
const MARKDOWN = ["README.md", "cli/README.md", "cli/CHANGELOG.md", "docs/agent-tooling.md", "cli/skill/SKILL.md"];

// Site files that vite.config.ts stamps at build time from the same package.json.
const TEMPLATES = ["index.html", "security.html", "src/llms.txt", "vite.config.ts"];
const COMMAND_PREFIX = /(npx -y (?:--loglevel=warn -- )?|npm i -g |"-y", ")$/;

describe("pinned CLI version", () => {
  it("comes from cli/package.json", () => {
    expect(STUBS_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.parse(read("cli/package.json")).version).toBe(STUBS_CLI_VERSION);
  });

  it.each(MARKDOWN)("is the only version %s tells anyone to run", (path) => {
    const text = read(path);
    // npx commands and MCP args arrays alike.
    const runs = [...text.matchAll(/@talix\/stubs(@[^\s"'`)\]]*)?(?=[\s"'`)\]]|$)/g)];
    const unpinned = runs.filter((m) => {
      const before = text.slice(Math.max(0, m.index! - 25), m.index!);
      // Mentions of the package by name (headings, prose, npm URLs) aren't run commands.
      const isCommand = COMMAND_PREFIX.test(before);
      return isCommand && m[1] !== `@${STUBS_CLI_VERSION}` && m[1] !== "@{{VERSION}}";
    });
    expect(unpinned.map((m) => m[0] + text.slice(m.index! + m[0].length, m.index! + m[0].length + 12))).toEqual([]);
  });

  it.each(["npx -y ", "npx -y --loglevel=warn -- ", "npm i -g ", '"-y", "'])("checks the version after %s", (prefix) => {
    expect(COMMAND_PREFIX.test(prefix)).toBe(true);
  });

  it("sync-version bumps the safe npx form and MCP configs, leaving historical versions alone", () => {
    const root = mkdtempSync(join(tmpdir(), "stubs-version-"));
    try {
      for (const dir of ["scripts", "cli", "docs"]) mkdirSync(join(root, dir));
      copyFileSync(new URL("../../scripts/sync-version.mjs", import.meta.url), join(root, "scripts/sync-version.mjs"));
      writeFileSync(join(root, "cli/package.json"), JSON.stringify({ version: "9.8.7-beta.1" }));
      writeFileSync(
        join(root, "cli/server.json"),
        JSON.stringify({ version: "0.1.0", packages: [{ registryType: "npm", version: "0.1.0" }] }),
      );
      const before = 'npx -y --loglevel=warn -- @talix/stubs@0.1.0 run -- pnpm test\n["-y", "@talix/stubs@0.2.0", "mcp"]\n';
      const after = 'npx -y --loglevel=warn -- @talix/stubs@9.8.7-beta.1 run -- pnpm test\n["-y", "@talix/stubs@9.8.7-beta.1", "mcp"]\n';
      for (const path of ["README.md", "cli/README.md", "docs/agent-tooling.md", "cli/CHANGELOG.md"]) {
        writeFileSync(join(root, path), before);
      }
      execFileSync(process.execPath, ["--", join(root, "scripts/sync-version.mjs")], { timeout: 5000 });
      for (const path of ["README.md", "cli/README.md", "docs/agent-tooling.md"]) {
        expect(readFileSync(join(root, path), "utf8")).toBe(after);
      }
      expect(readFileSync(join(root, "cli/CHANGELOG.md"), "utf8")).toBe(before);
      expect(execFileSync(process.execPath, ["--", join(root, "scripts/sync-version.mjs")], { timeout: 5000, encoding: "utf8" })).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(TEMPLATES)("%s carries only the placeholder, never a literal version", (path) => {
    const text = read(path);
    expect(text).toContain("@talix/stubs@{{STUBS_CLI_VERSION}}");
    expect(text.match(/@talix\/stubs@(?!\{\{STUBS_CLI_VERSION\}\})\S+/g)).toBeNull();
  });

  // The MCP Registry entry. `pnpm sync-version` rewrites both versions; the registry checks
  // that the npm package's mcpName matches the server name.
  it("is what cli/server.json publishes to the MCP Registry", () => {
    const server = JSON.parse(read("cli/server.json"));
    const pkg = JSON.parse(read("cli/package.json"));
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(STUBS_CLI_VERSION);
    expect(server.packages).toEqual([
      expect.objectContaining({ registryType: "npm", identifier: pkg.name, version: STUBS_CLI_VERSION }),
    ]);
  });
});
