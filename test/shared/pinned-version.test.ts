/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STUBS_CLI_VERSION } from "../../src/shared/stubs-cli";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

// Every place the site or docs tell someone (or an agent) to run the CLI. Each must pin the
// version being released, so nobody runs whatever happens to be newest on npm.
const FILES = [
  "README.md",
  "cli/README.md",
  "cli/CHANGELOG.md",
  "docs/agent-tooling.md",
  "index.html",
  "public/llms.txt",
  "cli/skill/SKILL.md",
];

describe("pinned CLI version", () => {
  it("matches the package being released", () => {
    expect(JSON.parse(read("cli/package.json")).version).toBe(STUBS_CLI_VERSION);
  });

  it.each(FILES)("is the only version %s tells anyone to run", (path) => {
    const text = read(path);
    // npx commands and MCP args arrays alike.
    const runs = [...text.matchAll(/@talix\/stubs(@[^\s"'`)\]]*)?(?=[\s"'`)\]]|$)/g)];
    const unpinned = runs.filter((m) => {
      const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 20);
      const before = text.slice(Math.max(0, m.index! - 25), m.index!);
      // Mentions of the package by name (headings, prose, npm URLs) aren't run commands.
      const isCommand = /(npx -y |npm i -g |"-y", ")$/.test(before);
      return isCommand && m[1] !== `@${STUBS_CLI_VERSION}` && m[1] !== "@{{VERSION}}";
    });
    expect(unpinned.map((m) => m[0] + text.slice(m.index! + m[0].length, m.index! + m[0].length + 12))).toEqual([]);
  });
});
