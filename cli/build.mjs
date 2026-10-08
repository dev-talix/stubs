// Bundles the CLI into dist/stubs.js. The file starts as a shell script that execs node with
// `--` before the script path, and only then as JavaScript. Node reads `--env-file` anywhere
// on its command line until it sees `--`, including after the script, and loads that file
// (NODE_OPTIONS included) before any of our code runs. The `--` stops that. The second line
// is a no-op in sh (`:`) and a string expression in JavaScript, so node runs the same file.
// Windows shims from npm run it as `sh stubs.js`, which needs sh on PATH (Git Bash does).

import { chmod } from "node:fs/promises";
import { build } from "esbuild";

const launcher = ['#!/usr/bin/env sh', '":" //; exec node -- "$0" "$@"'].join("\n");

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  loader: { ".md": "text" },
  outfile: "dist/stubs.js",
  banner: { js: launcher },
  logLevel: "info",
});
await chmod("dist/stubs.js", 0o755);
