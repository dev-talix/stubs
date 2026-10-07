// Rewrites every `@talix/stubs@<version>` in the markdown that GitHub and npm render as-is, so
// they match cli/package.json. The site reads the version directly (src/shared/stubs-cli.ts,
// vite.config.ts); the CHANGELOG keeps its historical versions and is left alone.
// test/shared/pinned-version.test.ts fails if any of these files drift.

import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("cli/package.json", root), "utf8"));
const FILES = ["README.md", "cli/README.md", "docs/agent-tooling.md"];
const PINNED = /@talix\/stubs@\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g;

for (const file of FILES) {
  const url = new URL(file, root);
  const before = readFileSync(url, "utf8");
  const after = before.replaceAll(PINNED, `@talix/stubs@${version}`);
  if (after === before) continue;
  writeFileSync(url, after);
  console.log(`${file}: pinned to ${version}`);
}
