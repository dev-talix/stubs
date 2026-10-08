import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { packageVersion } from "../src/version";
import { useTempDirs } from "./helpers/temp";

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = packageVersion();
const windows = process.platform === "win32";
const tempDir = useTempDirs();
const nodeDir = dirname(process.execPath);
const npm = windows ? join(nodeDir, "npm.cmd") : "npm";
const npx = windows ? join(nodeDir, "npx.cmd") : "npx";
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const cmd = join(systemRoot, "System32", "cmd.exe");
const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

beforeAll(async () => {
  await exec(process.execPath, ["build.mjs"], { cwd: join(ROOT, "cli") });
}, 60_000);

describe("the packed npm launcher", () => {
  it("finishes child commands that read standard input", async () => {
    const result = await execute(process.execPath, ["-e", 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("input ended\\n"));'], await tempDir(), process.env);
    expect(result).toEqual({ code: 0, stdout: "input ended\n", stderr: "" });
  }, 30_000);

  it("installs Node shims and runs the local package through the bin and offline npx", async () => {
    const cwd = join(await tempDir(), "project with spaces");
    await mkdir(cwd);
    const env = await privateEnv(cwd);
    // npm's own test switch generates its real Windows shims on POSIX too. Reading them
    // catches the regression locally; executing .cmd and .ps1 needs the Windows CI job.
    env.__TESTING_BIN_LINKS_PLATFORM__ = "win32";
    const packed = await execute(npm, ["pack", "--json", "--pack-destination", cwd], join(ROOT, "cli"), env);
    expect(packed.code, packed.stderr).toBe(0);
    const result = JSON.parse(packed.stdout);
    const metadata = Array.isArray(result) ? result[0] : Object.values(result)[0] as { filename: string };
    const installed = await execute(npm, ["install", "--no-save", join(cwd, metadata.filename)], cwd, env);
    expect(installed.code, installed.stderr).toBe(0);
    expect(await readFile(join(cwd, "node_modules/@talix/stubs/dist/stubs.js"), "utf8"))
      .toBe(await readFile(join(ROOT, "cli/dist/stubs.js"), "utf8"));

    const bin = join(cwd, "node_modules", ".bin", "stubs");
    const batch = await readFile(`${bin}.cmd`, "utf8");
    const ps = await readFile(`${bin}.ps1`, "utf8");
    expect(batch).toContain('SET "_prog=node"');
    expect(batch).toMatch(/"%_prog%" -- "[^"\r\n]+stubs\.js" %\*/);
    expect(ps).toMatch(/& "node\$exe" -- "[^"\r\n]+stubs\.js" \$args/);

    const launchers = [
      (args: string[]) => execute(windows ? `${bin}.cmd` : bin, args, cwd, env),
      (args: string[]) => execute(npx, ["-y", "--loglevel=warn", "--", `@talix/stubs@${version}`, ...args], cwd, env),
    ];
    if (windows) {
      launchers.push((args) => execute(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `${bin}.ps1`, ...args], cwd, env));
    } else {
      // Exercise the actual env -S shebang, rather than only npm's generated shell shim.
      launchers.push((args) => execute(join(ROOT, "cli/dist/stubs.js"), args, cwd, env));
    }
    for (const launch of launchers) {
      expect(await launch(["--version"])).toEqual({ code: 0, stdout: `${version}\n`, stderr: "" });
      const id = await launch(["id", "--json"]);
      expect(id.code).toBe(3);
      expect(JSON.parse(id.stdout)).toEqual({ ok: false, code: "invalid", message: "No identity yet. Run `stubs init`." });
      expect(id.stderr).toBe("");
    }
    const initialized = await launchers[0]!(["init", "--json"]);
    expect(initialized).toMatchObject({ code: 0, stderr: "" });
    const identity = JSON.parse(initialized.stdout);
    expect(identity).toMatchObject({ ok: true, created: true });
    expect(identity.publicId).toMatch(/^stubs1[A-Za-z0-9_-]{43}$/);
    for (const launch of launchers) {
      const id = await launch(["id", "--json"]);
      expect(id).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(id.stdout)).toMatchObject({ ok: true, publicId: identity.publicId });
    }

    const marker = join(cwd, "startup-hook-ran");
    const hook = join(cwd, "hook.cjs");
    await writeFile(hook, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); console.error("LAUNCHER_PRELOAD_CANARY");`);
    const requireEnv = join(cwd, "require.env");
    const importEnv = join(cwd, "import.env");
    await writeFile(requireEnv, `NODE_OPTIONS=--require "${hook.replace(/\\/g, "/")}"\n`);
    const importHook = `data:text/javascript,${encodeURIComponent(`import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran"); console.error("LAUNCHER_PRELOAD_CANARY");`)}`;
    await writeFile(importEnv, `NODE_OPTIONS=--import=${importHook}\n`);
    for (const launch of launchers) {
      for (const file of [requireEnv, importEnv, join(cwd, "missing.env")]) {
        for (const flag of [["--env-file", file], [`--env-file=${file}`], ["--env-file-if-exists", file], [`--env-file-if-exists=${file}`]]) {
          const result = await launch(["run", ...flag, "--", "never-started"]);
          expect(result).toMatchObject({ code: 125, stdout: "" });
          expect(result.stderr).toContain("Use --from <file>");
          expect(result.stderr).not.toContain("LAUNCHER_PRELOAD_CANARY");
          expect(await access(marker).then(() => true, () => false)).toBe(false);
        }
      }
    }
  }, 60_000);

  it.runIf(windows && process.env.STUBS_TEST_PUBLISHED_LAUNCHER === "1")("reproduces the published 0.4.0 failure without sh", async () => {
    const cwd = await tempDir();
    const env = await privateEnv(cwd);
    env.npm_config_offline = "false";
    const installed = await execute(npm, ["install", "--no-save", "@talix/stubs@0.4.0"], cwd, env);
    expect(installed.code, installed.stderr).toBe(0);
    const result = await execute(join(cwd, "node_modules", ".bin", "stubs.cmd"), ["--version"], cwd, env);
    expect(result.code, result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(/'(?:sh|"sh")' is not recognized/);
  }, 60_000);
});

async function privateEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: cwd,
    USERPROFILE: cwd,
    XDG_CONFIG_HOME: join(cwd, "config"),
    npm_config_cache: join(cwd, "npm-cache"),
    npm_config_userconfig: join(cwd, "npmrc"),
    npm_config_globalconfig: join(cwd, "global-npmrc"),
    npm_config_offline: "true",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_registry: "https://registry.npmjs.org",
  };
  delete env.NODE_OPTIONS;
  delete env.STUBS_ORIGIN;
  await mkdir(env.XDG_CONFIG_HOME!, { recursive: true });
  await writeFile(env.npm_config_userconfig!, "");
  await writeFile(env.npm_config_globalconfig!, "");
  if (windows) {
    // Keep Node, npm and Windows utilities, excluding Git Bash and every other sh provider.
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.PATH = [nodeDir, join(systemRoot, "System32"), systemRoot].join(delimiter);
    const found = await execute(join(systemRoot, "System32", "where.exe"), ["sh"], cwd, env);
    expect(found.code, "Windows launcher tests require sh to be absent from PATH").not.toBe(0);
  }
  return env;
}

async function execute(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  let command = executable;
  let argv = args;
  if (windows && executable.endsWith(".cmd")) {
    command = cmd;
    // These arguments are controlled fixtures, not user input. /s removes the outer quotes.
    argv = ["/d", "/s", "/c", `"${[executable, ...args].map((arg) => `"${arg}"`).join(" ")}"`];
  }
  try {
    const pending = exec(command, argv, {
      cwd,
      env,
      windowsVerbatimArguments: windows && executable.endsWith(".cmd"),
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    // No fixture supplies input. PowerShell's npm shim waits for EOF on piped stdin.
    pending.child.stdin?.end();
    const result = await pending;
    return { code: 0, stdout: result.stdout.replace(/\r\n/g, "\n"), stderr: result.stderr.replace(/\r\n/g, "\n") };
  } catch (error) {
    const failed = error as Error & { code: number; stdout: string; stderr: string; killed?: boolean };
    if (typeof failed.code !== "number" || failed.killed) throw error;
    return { code: failed.code, stdout: failed.stdout.replace(/\r\n/g, "\n"), stderr: failed.stderr.replace(/\r\n/g, "\n") };
  }
}
