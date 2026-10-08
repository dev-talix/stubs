/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/sync-version.mjs", import.meta.url));

// The script resolves every file from its own location, so a copy in a temp tree runs against
// that tree and never touches the repository.
let root: string;

function setUp(serverText: string) {
  root = mkdtempSync(join(tmpdir(), "stubs-sync-"));
  for (const dir of ["scripts", "cli", "docs"]) mkdirSync(join(root, dir));
  copyFileSync(SCRIPT, join(root, "scripts/sync-version.mjs"));
  writeFileSync(join(root, "cli/package.json"), JSON.stringify({ name: "@talix/stubs", version: "9.8.7" }));
  for (const file of ["README.md", "cli/README.md", "docs/agent-tooling.md"]) {
    writeFileSync(join(root, file), "Run `npx -y @talix/stubs@0.1.0 pull <link>`.\n");
  }
  writeFileSync(join(root, "cli/server.json"), serverText);
}

const sync = () => spawnSync(process.execPath, [join(root, "scripts/sync-version.mjs")], { encoding: "utf8" });
const read = (file: string) => readFileSync(join(root, file), "utf8");

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("pnpm sync-version", () => {
  it("bumps the markdown pins and both server.json versions, and leaves everything else alone", () => {
    const server = {
      $schema: "https://example.test/schema.json",
      name: "app.talix/stubs",
      version: "0.1.0",
      packages: [
        { registryType: "npm", identifier: "@talix/stubs", version: "0.1.0", transport: { type: "stdio" } },
        { registryType: "npm", identifier: "something-else", version: "1.2.3" },
      ],
    };
    setUp(`${JSON.stringify(server, null, 2)}\n`);

    const first = sync();
    expect(first.status).toBe(0);
    expect(read("README.md")).toBe("Run `npx -y @talix/stubs@9.8.7 pull <link>`.\n");
    expect(read("docs/agent-tooling.md")).toContain("@talix/stubs@9.8.7");
    expect(JSON.parse(read("cli/server.json"))).toEqual({
      ...server,
      version: "9.8.7",
      packages: [{ ...server.packages[0], version: "9.8.7" }, server.packages[1]],
    });

    // A second run has nothing to change.
    const second = sync();
    expect(second.status).toBe(0);
    expect(second.stdout).toBe("");
  });

  it("fails on malformed server.json without rewriting it", () => {
    setUp("{ not json\n");
    const result = sync();
    expect(result.status).not.toBe(0);
    expect(read("cli/server.json")).toBe("{ not json\n");
  });
});
