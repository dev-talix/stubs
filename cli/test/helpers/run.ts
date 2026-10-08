import { Writable } from "node:stream";
import { run } from "../../src/cli";
import type { FakeServer } from "./fake-server";

export const ORIGIN = "https://stubs.talix.app";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A sink that appends everything written to it onto `into`. */
function collector(into: { text: string }): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      into.text += chunk.toString("utf8");
      callback();
    },
  });
}

/** Runs the CLI in-process against a fake server, capturing both streams. */
export async function runCli(
  args: string[],
  options: {
    server: FakeServer;
    cwd: string;
    stdin?: string;
    env?: Record<string, string>;
    home?: string;
    version?: string | null;
  },
): Promise<RunResult> {
  const stdout = { text: "" };
  const stderr = { text: "" };
  const code = await run(args, {
    stdout: (text) => (stdout.text += text),
    stderr: (text) => (stderr.text += text),
    env: options.env ?? {},
    cwd: options.cwd,
    // No identity unless a test sets one up.
    home: options.home ?? "/nonexistent/stubs-test-home",
    makeTransport: () => options.server.transport,
    readStdin: async () => options.stdin ?? "",
    run: { stdout: collector(stdout), stderr: collector(stderr), stdin: "ignore" },
    version: options.version,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}
