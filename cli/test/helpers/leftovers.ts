import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach } from "vitest";

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes sure a test that runs commands can't leave one behind when it fails or times out.
 * After each test, every process registered with `track` gets SIGKILL, and so does the pid
 * written to `pid` in the test's working directory, along with its process group. A command
 * under test that should outlive nothing writes its pid there.
 */
export function useLeftoverKiller(cwdOf: () => string): <T extends ChildProcess>(child: T) => T {
  const tracked: ChildProcess[] = [];
  afterEach(async () => {
    for (const child of tracked.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    const pid = Number(await readFile(join(cwdOf(), "pid"), "utf8").catch(() => ""));
    if (!Number.isInteger(pid) || pid <= 0) return;
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  return (child) => {
    tracked.push(child);
    return child;
  };
}
