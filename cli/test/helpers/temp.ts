import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

/** A fresh temp directory per call, removed after each test. */
export function useTempDirs(): () => Promise<string> {
  const made: string[] = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "stubs-cli-")));
    made.push(dir);
    return dir;
  };
}
