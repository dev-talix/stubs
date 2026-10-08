// Entry point for the `stubs` binary.

import { homedir } from "node:os";
import { run } from "./cli";
import { readHiddenInput } from "./prompt";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// A crash must never turn into a stack trace: an error object could carry anything the command
// was holding. This covers errors thrown outside the promise chain below (stream errors, and
// anything a dependency throws from a callback). process.exit runs the `exit` handlers, which
// is where `stubs run` kills whatever it was running.
const crashed = () => {
  process.stderr.write("stubs: unexpected error.\n");
  process.exit(1);
};
process.on("uncaughtException", crashed);
process.on("unhandledRejection", crashed);
// Our reader went away (`stubs --help | head -1`): stop quietly instead of crashing.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") crashed();
  });
}

run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
  home: homedir(),
  makeTransport: (origin) => (path, init) => fetch(origin + path, init),
  readStdin,
  readPrompt: readHiddenInput,
  run: { stdout: process.stdout, stderr: process.stderr, stdin: "inherit" },
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
