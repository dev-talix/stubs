// Rewrites every `@talix/stubs@<version>` in the markdown that GitHub and npm render as-is, and
// both versions in cli/server.json (the MCP Registry entry), so they match cli/package.json. The
// site reads the version directly (src/shared/stubs-cli.ts, vite.config.ts); the CHANGELOG
// keeps its historical versions and is left alone.
// test/shared/pinned-version.test.ts fails if any of these files drift.

import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("cli/package.json", root), "utf8"));
const FILES = ["README.md", "cli/README.md", "docs/agent-tooling.md"];
const PINNED = /@talix\/stubs@\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g;

function write(file, before, after) {
  if (after === before) return;
  writeFileSync(new URL(file, root), after);
  console.log(`${file}: pinned to ${version}`);
}

for (const file of FILES) {
  const before = readFileSync(new URL(file, root), "utf8");
  write(file, before, before.replaceAll(PINNED, `@talix/stubs@${version}`));
}

const SERVER = "cli/server.json";
const serverText = readFileSync(new URL(SERVER, root), "utf8");
const server = JSON.parse(serverText);
server.version = version;
for (const pkg of server.packages) {
  if (pkg.identifier === "@talix/stubs") pkg.version = version;
}
write(SERVER, serverText, `${JSON.stringify(server, null, 2)}\n`);
