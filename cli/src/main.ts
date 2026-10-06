// Entry point for the `stubs` binary.

import { homedir } from "node:os";
import { run } from "./cli";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
  home: homedir(),
  makeTransport: (origin) => (path, init) => fetch(origin + path, init),
  readStdin,
}).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // Never print the thrown error: it could carry anything the command was holding.
    process.stderr.write("stubs: unexpected error.\n");
    process.exitCode = 1;
  },
);
