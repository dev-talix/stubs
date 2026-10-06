import { run } from "../../src/cli";
import type { FakeServer } from "./fake-server";

export const ORIGIN = "https://stubs.talix.app";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
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
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    env: options.env ?? {},
    cwd: options.cwd,
    // No identity unless a test sets one up.
    home: options.home ?? "/nonexistent/stubs-test-home",
    makeTransport: () => options.server.transport,
    readStdin: async () => options.stdin ?? "",
    version: options.version,
  });
  return { code, stdout, stderr };
}
