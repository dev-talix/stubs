// Node scans for --env-file before our code runs, including arguments after the script.
// Keep -- before the script path. Unix env -S splits the shebang arguments; npm's Windows
// shims read them directly and invoke node -- without requiring a shell interpreter.

import { chmod } from "node:fs/promises";
import { build } from "esbuild";

const launcher = "#!/usr/bin/env -S node --";

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
