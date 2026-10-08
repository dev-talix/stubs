/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STUBS_CLI_VERSION } from "../../src/shared/stubs-cli";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

// Markdown that GitHub and npm render as-is, so it has to carry the literal version.
// `pnpm sync-version` rewrites it; this test catches a bump that skipped that step.
const MARKDOWN = ["README.md", "cli/README.md", "cli/CHANGELOG.md", "docs/agent-tooling.md", "cli/skill/SKILL.md"];

// Site files that vite.config.ts stamps at build time from the same package.json.
const TEMPLATES = ["index.html", "security.html", "src/llms.txt"];

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
      const isCommand = /(npx -y |npm i -g |"-y", ")$/.test(before);
      return isCommand && m[1] !== `@${STUBS_CLI_VERSION}` && m[1] !== "@{{VERSION}}";
    });
    expect(unpinned.map((m) => m[0] + text.slice(m.index! + m[0].length, m.index! + m[0].length + 12))).toEqual([]);
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
