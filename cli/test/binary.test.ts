// Runs the built binary against a real HTTP fake server and checks that no value and no link
// fragment ever reaches stdout or stderr (R6), on success and on every post-claim failure.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/core/lock";
import { fakeServer, type FakeServer } from "./helpers/fake-server";
import { alive, useLeftoverKiller } from "./helpers/leftovers";
import { useTempDirs } from "./helpers/temp";

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "cli/dist/stubs.js");
const CANARY = "hunter2-9f3a";
const STUB = `CANARY_SECRET=${CANARY}\nOTHER=x-${CANARY}-y\nnot a pair ${CANARY}\n`;

const tempDir = useTempDirs();
const track = useLeftoverKiller(() => cwd);
let server: FakeServer;
let http: { origin: string; close: () => Promise<void> };
let cwd: string;
let xdg: string;

beforeAll(async () => {
  await exec("pnpm", ["--filter", "@talix/stubs", "build"], { cwd: ROOT });
}, 60_000);

beforeEach(async () => {
  server = fakeServer();
  http = await server.listen();
  cwd = await tempDir();
  xdg = await tempDir();
  return () => http.close();
});

function stubs(
  args: string[],
  stdin = "",
  { origin = true }: { origin?: boolean } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // A private config home, so tests never see or touch the real identity.
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdg };
  delete env.STUBS_ORIGIN;
  const argv = origin ? [...args, "--origin", http.origin] : args;
  return new Promise((done, failed) => {
    const child = track(spawn(process.execPath, [BIN, ...argv], { cwd, env }));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", failed);
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/** Pulls `link` and asserts neither stream carries the canary, the fragment, or `secrets`. */
async function pullClean(link: string, ...args: string[]) {
  return pullWithout([], link, ...args);
}

async function pullWithout(secrets: string[], link: string, ...args: string[]) {
  const result = await stubs(["pull", link, ...args]);
  const fragment = link.slice(link.indexOf("#") + 1);
  for (const stream of [result.stdout, result.stderr]) {
    expect(stream).not.toContain(CANARY);
    expect(stream).not.toContain(fragment);
    expect(stream).not.toContain(fragment.slice(3, 23));
    for (const secret of secrets) expect(stream).not.toContain(secret);
  }
  if (args.includes("--json")) {
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    JSON.parse(result.stdout);
  }
  return result;
}

const posix = process.platform !== "win32";
/** script(1) gives the binary a real terminal on both streams; its syntax differs by platform. */
const pty = posix && (await stat("/usr/bin/script").then(() => true, () => false));
const hasGit = await exec("git", ["--version"]).then(() => true, () => false);

/** Runs the binary under script(1), so stdout and stderr are a PTY; returns everything it showed. */
function atTerminal(args: string[]): Promise<{ output: string }> {
  const command = [process.execPath, BIN, ...args];
  const argv =
    process.platform === "darwin"
      ? ["-q", "/dev/null", ...command]
      : ["-q", "-c", command.map((part) => `'${part.replace(/'/g, "'\\''")}'`).join(" "), "/dev/null"];
  return new Promise((done, failed) => {
    const child = track(spawn("/usr/bin/script", argv, { cwd, env: { ...process.env, XDG_CONFIG_HOME: xdg }, stdio: ["ignore", "pipe", "pipe"] }));
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", failed);
    child.on("close", () => done({ output: output.replace(/\r/g, "") }));
  });
}

const closed = (child: ChildProcess) => new Promise<number | null>((done) => child.on("close", (code) => done(code)));

/** A `--import` data URL that writes `marker` and prints a canary, for a hostile NODE_OPTIONS. */
const inlineHook = (marker: string) =>
  `data:text/javascript,${encodeURIComponent(`import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran"); console.error("startup-${CANARY}")`)}`;

/** Runs `executable` as the kernel would (shebang and all), not through `node`. */
function launched(executable: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, failed) => {
    const child = track(spawn(executable, args, { cwd, env: { ...process.env, XDG_CONFIG_HOME: xdg } }));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", failed);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

describe.each([[[]], [["--json"]]])("stubs pull %j", (flags) => {
  it("succeeds without printing values", async () => {
    const link = await server.seed(STUB, http.origin);
    const result = await pullClean(link, ...flags);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("CANARY_SECRET");
    expect(await readFile(join(cwd, ".env.local"), "utf8")).toContain(`CANARY_SECRET=${CANARY}`);
  });

  it("skips conflicting keys without printing either value", async () => {
    await writeFile(join(cwd, ".env.local"), "CANARY_SECRET=old-value\n");
    const link = await server.seed(STUB, http.origin);
    const result = await pullClean(link, ...flags);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("old-value");
    expect(await readFile(join(cwd, ".env.local"), "utf8")).toMatch(/^CANARY_SECRET=old-value\n/);
  });

  it("exits 6 on a tampered stub", async () => {
    const link = await server.seed(STUB, http.origin);
    server.tamperAll();
    expect((await pullClean(link, ...flags)).code).toBe(6);
  });

  it("exits 2 on a second pull", async () => {
    const link = await server.seed(STUB, http.origin);
    await pullClean(link, ...flags);
    expect((await pullClean(link, ...flags, "--to", "again.env")).code).toBe(2);
  });

  it("exits 7 when the connection drops mid-claim", async () => {
    const link = await server.seed(STUB, http.origin);
    server.dropClaims = true;
    expect((await pullClean(link, ...flags)).code).toBe(7);
  });

  it("saves to a recovery file when the write fails after the claim", async () => {
    await writeFile(join(cwd, ".env.local"), "");
    const link = await server.seed(STUB, http.origin);
    server.onClaim = async () => {
      await rm(join(cwd, ".env.local"));
      await mkdir(join(cwd, ".env.local"));
    };
    const result = await pullClean(link, ...flags);
    expect(result.code).toBe(1);
    const [saved] = await readdir(join(xdg, "stubs", "recovered"));
    expect(result.stdout + result.stderr).toContain(join(xdg, "stubs", "recovered", saved!));
    expect(await readFile(join(xdg, "stubs", "recovered", saved!), "utf8")).toBe(STUB);
    expect(await readdir(cwd)).toEqual([".env.local"]);
  });

  it("exits 3 on a malformed link without echoing it", async () => {
    const link = await server.seed(STUB, http.origin);
    expect((await pullClean(link.slice(0, -2), ...flags)).code).toBe(3);
    expect(server.store.size).toBe(1);
  });

  it("reports a malformed existing line by number, never by content", async () => {
    await writeFile(join(cwd, ".env.local"), `BAD="unclosed ${CANARY}\n`);
    const link = await server.seed("FINE=1\n", http.origin);
    const result = await pullClean(link, ...flags);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toContain("Line 1 of .env.local is malformed");
    expect(result.stdout + result.stderr).not.toContain("unclosed");
  });
});

describe.each([[[]], [["--json"]]])("stubs push %j", (flags) => {
  it("never prints the file's values, on success or any failure", async () => {
    await writeFile(join(cwd, ".env.local"), STUB);
    const runs = [
      await stubs(["push", ...flags]),
      await stubs(["push", "--ttl", "2h", ...flags]),
      await stubs(["push", "--to", "stubs1not-an-id", ...flags]),
      await stubs(["push", "-", ...flags], STUB),
    ];
    server.rateLimited = true;
    runs.push(await stubs(["push", ...flags]));
    expect(runs.map((run) => run.code)).toEqual([0, 3, 3, 0, 4]);
    for (const run of runs) {
      for (const stream of [run.stdout, run.stderr]) expect(stream).not.toContain(CANARY);
    }
  });
});

describe("locked stubs through the binary", () => {
  async function init() {
    const created = await stubs(["init", "--json"], "", { origin: false });
    expect(created.code).toBe(0);
    const { publicId } = JSON.parse(created.stdout);
    const file = await readFile(join(xdg, "stubs/identity"), "utf8");
    const secret = file.split("\n")[1]!;
    return { publicId: publicId as string, secret, secrets: [publicId as string, secret, secret.slice(-20)] };
  }

  it("init and id print the public id; init refuses a second time", async () => {
    const human = await stubs(["init"], "", { origin: false });
    expect(human.code).toBe(0);
    const publicId = /Your stubs id: (\S+)/.exec(human.stdout)?.[1];
    expect(publicId).toMatch(/^stubs1[\w-]{43}$/);
    const secret = (await readFile(join(xdg, "stubs/identity"), "utf8")).split("\n")[1]!;
    const id = await stubs(["id"], "", { origin: false });
    expect(id).toMatchObject({ code: 0, stdout: `${publicId}\n` });
    expect((await stubs(["init"], "", { origin: false })).code).toBe(3);
    for (const output of [human, id]) expect(output.stdout + output.stderr).not.toContain(secret);
  });

  it.each([[[]], [["--json"]]])("pulls a locked stub %j without printing values, the secret, or the id", async (flags) => {
    const { publicId, secrets } = await init();
    const link = await server.seed(STUB, http.origin, publicId);
    expect((await stubs(["check", link, ...flags])).code).toBe(0);
    const result = await pullWithout(secrets, link, ...flags);
    expect(result.code).toBe(0);
    expect(await readFile(join(cwd, ".env.local"), "utf8")).toContain(`CANARY_SECRET=${CANARY}`);
    expect((await pullWithout(secrets, link, ...flags, "--to", "again.env")).code).toBe(2);
  });

  it("refuses a stub locked to another machine without a request", async () => {
    const { secrets } = await init();
    const link = await server.seed(STUB, http.origin, (await generateIdentity()).publicId);
    const result = await pullWithout(secrets, link);
    expect(result.code).toBe(3);
    expect(server.sent).toEqual([]);
  });

  it("push --to round-trips to the identity holder", async () => {
    const { publicId, secrets } = await init();
    const pushed = await stubs(["push", "-", "--to", publicId], STUB);
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).toContain(`Locked to ${publicId}.`);
    expect((await pullWithout(secrets, pushed.stdout.trim())).code).toBe(0);
  });
});

describe("stubs run through the binary", () => {
  const dump = `
    const fs = require("node:fs");
    console.log("env:", process.env.CANARY_SECRET, process.env.OTHER);
    console.error("err:", JSON.stringify(process.env.OTHER), Buffer.from(process.env.CANARY_SECRET).toString("base64"));
    process.stdout.write(fs.readFileSync(".env.local", "utf8"));
    process.exit(3);
  `;

  it("masks pulled values in the command's output", async () => {
    const link = await server.seed(STUB, http.origin);
    expect((await pullClean(link)).code).toBe(0);
    const result = await stubs(["run", "--", process.execPath, "-e", dump], "", { origin: false });
    expect(result.code).toBe(3);
    for (const stream of [result.stdout, result.stderr]) expect(stream).not.toContain(CANARY);
    expect(result.stdout).toBe(
      "env: [stubs:CANARY_SECRET] [stubs:OTHER]\nCANARY_SECRET=[stubs:CANARY_SECRET]\nOTHER=[stubs:OTHER]\n# unparsed: [stubs:unparsed]\n",
    );
    expect(result.stderr).toBe('err: "[stubs:OTHER]" [stubs:CANARY_SECRET]\n');
  });

  it("masks lowercase URL encoding with plus spaces in both streams and keeps the exit code", async () => {
    await writeFile(join(cwd, ".env.local"), "CANARY_SECRET='hunter2/+ phrase'\n");
    const script = `
      const encoded = encodeURIComponent(process.env.CANARY_SECRET)
        .replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()).replace(/%20/g, "+");
      process.stdout.write("out: " + encoded.slice(0, 9));
      process.stderr.write("err: " + encoded.slice(0, 12));
      setTimeout(() => {
        process.stdout.write(encoded.slice(9) + "\\n");
        process.stderr.write(encoded.slice(12) + "\\n");
        process.exitCode = 7;
      }, 150);
    `;
    expect(await launched(BIN, ["run", "--", process.execPath, "-e", script])).toEqual({
      code: 7,
      stdout: "out: [stubs:CANARY_SECRET]\n",
      stderr: "err: [stubs:CANARY_SECRET]\n",
    });
  });

  it.runIf(pty)("at a real terminal, masks a value written in two halves with a pause, and has no --unmasked", async () => {
    await writeFile(join(cwd, ".env.local"), `CANARY_SECRET=${CANARY}\n`);
    const halves = `
      const key = process.env.CANARY_SECRET;
      process.stdout.write("a=" + key.slice(0, 4));
      setTimeout(() => process.stdout.write(key.slice(4) + "\\n"), 180);
    `;
    const masked = await atTerminal(["run", "--", process.execPath, "-e", halves]);
    expect(masked.output).toContain("a=[stubs:CANARY_SECRET]");
    expect(masked.output).not.toContain(CANARY);

    const unmasked = await atTerminal(["run", "--unmasked", "--", process.execPath, "-e", "console.log(process.env.CANARY_SECRET)"]);
    expect(unmasked.output).toContain("unknown flag");
    expect(unmasked.output).not.toContain(CANARY);
  }, 20_000);

  it.runIf(posix)("stops the whole process tree when the reader goes away, even a command that ignores the write error", async () => {
    await writeFile(join(cwd, ".env.local"), `CANARY_SECRET=${CANARY}\n`);
    const chatty = `
      process.stdout.on("error", () => {});
      require("node:fs").writeFileSync("pid", String(process.pid));
      setInterval(() => process.stdout.write(process.env.CANARY_SECRET + "\\n"), 5);
    `;
    const child = track(spawn(process.execPath, [BIN, "run", "--", process.execPath, "-e", chatty], { cwd, env: { ...process.env, XDG_CONFIG_HOME: xdg } }));
    const first = await new Promise<string>((done) => child.stdout.once("data", (chunk: Buffer) => done(chunk.toString())));
    expect(first).toContain("[stubs:CANARY_SECRET]");
    child.stdout.destroy();
    const code = await Promise.race([closed(child), sleep(5000).then(() => "hung")]);
    expect(code).toBe(128 + 13);
    expect(alive(Number(await readFile(join(cwd, "pid"), "utf8")))).toBe(false);
  }, 10_000);

  it.runIf(posix)("on SIGTERM, stops the command and everything it started", async () => {
    await writeFile(join(cwd, ".env.local"), `CANARY_SECRET=${CANARY}\n`);
    const idle = `require("node:fs").writeFileSync("pid", String(process.pid)); console.log("up"); setTimeout(() => {}, 60000)`;
    const tree = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(idle)} & wait`;
    const child = track(spawn(process.execPath, [BIN, "run", "--", "sh", "-c", tree], { cwd, env: { ...process.env, XDG_CONFIG_HOME: xdg } }));
    await new Promise<void>((done) => child.stdout.once("data", () => done()));
    child.kill("SIGTERM");
    const code = await Promise.race([closed(child), sleep(5000).then(() => "hung")]);
    expect(code).not.toBe("hung");
    await sleep(50);
    expect(alive(Number(await readFile(join(cwd, "pid"), "utf8")))).toBe(false);
  }, 10_000);

  it.runIf(posix)("on a crash, stops the command before exiting", async () => {
    await writeFile(join(cwd, ".env.local"), `CANARY_SECRET=${CANARY}\n`);
    const preload = join(cwd, "throw-later.cjs");
    await writeFile(preload, `setTimeout(() => { throw new Error("leaked ${CANARY}"); }, 400);`);
    const idle = `require("node:fs").writeFileSync("pid", String(process.pid)); setTimeout(() => {}, 60000)`;
    const result = await new Promise<{ code: number | null; stderr: string }>((done) => {
      const child = track(spawn(process.execPath, ["--require", preload, BIN, "run", "--", process.execPath, "-e", idle], { cwd, env: { ...process.env, XDG_CONFIG_HOME: xdg } }));
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (code) => done({ code, stderr }));
    });
    expect(result).toEqual({ code: 1, stderr: "stubs: unexpected error.\n" });
    await sleep(50);
    expect(alive(Number(await readFile(join(cwd, "pid"), "utf8")))).toBe(false);
  }, 10_000);

  it.runIf(posix)("reads --from itself, so a hostile NODE_OPTIONS never reaches the stubs process", async () => {
    const marker = join(cwd, "executed");
    await writeFile(join(cwd, "evil.env"), `API_KEY=${CANARY}\nNODE_OPTIONS=--import=${inlineHook(marker)}\n`);
    const hostile = await launched(BIN, ["run", "--from", "evil.env", "--", process.execPath, "-e", "console.log('ran')"]);
    expect(hostile).toEqual({
      code: 125,
      stdout: "",
      stderr: "stubs: NODE_OPTIONS can't come from an env file: keys like that change which code programs run. Take it out of the file, or set it in your shell on purpose.\n",
    });
    expect(await stat(marker).then(() => true, () => false)).toBe(false);

    const missing = await launched(BIN, ["run", "--from", `${CANARY}.missing`, "--", process.execPath, "-e", "1"]);
    expect(missing).toEqual({ code: 125, stdout: "", stderr: "stubs: The --from file doesn't exist. Pull a stub first, or check --from.\n" });
  });

  it.runIf(posix)("as the shipped executable, keeps Node from reading an --env-file typo before stubs runs", async () => {
    // The launcher execs `node -- stubs.js`, so Node's own --env-file scan stops before our
    // arguments. Checked as the file itself and through a symlink, which is how npm installs a bin.
    const marker = join(cwd, "executed");
    const hook = join(cwd, "hook.cjs");
    await writeFile(hook, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); console.error("startup-${CANARY}");`);
    await writeFile(join(cwd, "require.env"), `API_KEY=${CANARY}\nNODE_OPTIONS=--require ${hook}\n`);
    await writeFile(join(cwd, "import.env"), `API_KEY=${CANARY}\nNODE_OPTIONS=--import=${inlineHook(marker)}\n`);
    await mkdir(join(cwd, "bin"));
    await symlink(BIN, join(cwd, "bin", "stubs"));
    const spellings = (file: string) => [
      ["--env-file", file],
      [`--env-file=${file}`],
      ["--env-file-if-exists", file],
      [`--env-file-if-exists=${file}`],
    ];
    const cases = [...spellings("require.env"), ...spellings("import.env"), ...spellings(`${CANARY}.missing`)];
    for (const executable of [BIN, join(cwd, "bin", "stubs")]) {
      for (const flag of cases) {
        const result = await launched(executable, ["run", ...flag, "--", process.execPath, "-e", "console.log('ran')"]);
        expect(result).toEqual({
          code: 125,
          stdout: "",
          stderr: "stubs: stubs run doesn't take --env-file: that's a Node flag, and Node would read the file itself. Use --from <file>. Run `stubs run --help`.\n",
        });
      }
    }
    expect(await stat(marker).then(() => true, () => false)).toBe(false);
    // The same file still runs as a plain node script, which is the unprotected path the docs name.
    expect(await stubs(["--version"], "", { origin: false })).toMatchObject({ code: 0 });
  }, 60_000);

  it.runIf(posix)("through offline npx, refuses startup flags with the skill's prefix; without its early --, leaks", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: cwd,
      XDG_CONFIG_HOME: xdg,
      npm_config_cache: join(cwd, "npm-cache"),
      npm_config_userconfig: join(cwd, "npmrc"),
      npm_config_globalconfig: join(cwd, "global-npmrc"),
      npm_config_offline: "true",
      npm_config_ignore_scripts: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    };
    await writeFile(env.npm_config_userconfig!, "");
    await writeFile(env.npm_config_globalconfig!, "");
    // Kill the whole npm group on timeout or completion, including any shim it started.
    const npm = async (command: string, args: string[], directory = cwd) => {
      const child = track(spawn(command, args, { cwd: directory, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }));
      const stop = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      };
      const timer = setTimeout(stop, 10_000);
      try {
        return await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, failed) => {
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
          child.on("error", failed);
          child.on("close", (code) => done({ code, stdout, stderr }));
        });
      } finally {
        clearTimeout(timer);
        stop();
        for (let tries = 0; child.pid !== undefined && alive(-child.pid) && tries < 100; tries++) await sleep(10);
        if (child.pid !== undefined) expect(alive(-child.pid)).toBe(false);
      }
    };
    // beforeAll built the package. Packing without scripts avoids another build or install.
    const packed = await npm("npm", ["pack", "--json", "--pack-destination", cwd], join(ROOT, "cli"));
    expect(packed.code).toBe(0);
    // npm 10 and 11 print an array; npm 12 prints an object keyed by package name.
    const pack = JSON.parse(packed.stdout);
    const tarball = join(cwd, (Array.isArray(pack) ? pack[0] : Object.values(pack)[0]).filename);
    const skill = await readFile(join(ROOT, "cli/skill/SKILL.md"), "utf8");
    const prefix = /npx (-y (?:--loglevel=warn )?(?:-- )?)@talix\/stubs@\{\{VERSION\}\} run -- pnpm test/.exec(skill);
    expect(prefix).not.toBeNull();
    const recommended = prefix![1]!.trim().split(" ");
    const marker = join(cwd, "executed");
    const hook = join(cwd, "hook.cjs");
    await writeFile(hook, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); console.error("startup-${CANARY}");`);
    await writeFile(join(cwd, "require.env"), `NODE_OPTIONS=--require ${hook}\n`);
    await writeFile(join(cwd, "import.env"), `NODE_OPTIONS=--import=${inlineHook(marker)}\n`);
    for (const file of ["require.env", "import.env", `${CANARY}.missing`]) {
      for (const flag of [["--env-file", file], [`--env-file=${file}`], ["--env-file-if-exists", file], [`--env-file-if-exists=${file}`]]) {
        const args = [`file:${tarball}`, "run", ...flag, "--", process.execPath, "-e", "1"];
        const safe = await npm("npx", [...recommended, ...args]);
        expect.soft(safe, flag.join(" ")).toEqual({
          code: 125,
          stdout: "",
          stderr: "stubs: stubs run doesn't take --env-file: that's a Node flag, and Node would read the file itself. Use --from <file>. Run `stubs run --help`.\n",
        });
        expect.soft(safe.stdout + safe.stderr).not.toContain(CANARY);
        expect.soft(await stat(marker).then(() => true, () => false)).toBe(false);
        await rm(marker, { force: true });

        // Node reads these flags in npx itself before our launcher can refuse them.
        const unsafe = await npm("npx", ["-y", ...args]);
        expect(unsafe.stdout + unsafe.stderr).toContain(CANARY);
        expect(await stat(marker).then(() => true, () => false)).toBe(!file.endsWith(".missing"));
        await rm(marker, { force: true });
      }
    }
  }, 60_000);

  it("delivers all of a command's output to a slow reader and keeps its exit code", async () => {
    await writeFile(join(cwd, ".env.local"), `CANARY_SECRET=${CANARY}\n`);
    // Enough to fill every buffer between the command and this process, so the command's last
    // bytes are still queued when it exits and every deadline in the runner has passed.
    const size = 300000;
    const script = `process.stdout.write("z".repeat(${size}), () => process.stdout.write("DONE\\n", () => process.exit(7)))`;
    const child = track(spawn(process.execPath, [BIN, "run", "--", process.execPath, "-e", script], { cwd, env: { ...process.env, XDG_CONFIG_HOME: xdg } }));
    const done = closed(child);
    await sleep(4000);
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    const code = await Promise.race([done, sleep(5000).then(() => "hung")]);
    expect(code).toBe(7);
    expect(stdout.length).toBe(size + 5);
    expect(stdout.endsWith("DONE\n")).toBe(true);
  }, 15_000);

  it("returns as soon as a short command is done", async () => {
    await writeFile(join(cwd, ".env.local"), `CANARY_SECRET=${CANARY}\n`);
    const started = Date.now();
    const result = await stubs(["run", "--", process.execPath, "-e", "process.exit(7)"], "", { origin: false });
    expect(result.code).toBe(7);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it.runIf(posix)("stops a leftover in the group that ignores SIGTERM and holds no pipe, before returning", async () => {
    await writeFile(join(cwd, ".env.local"), `CANARY_SECRET=${CANARY}\n`);
    const stubborn = `require("node:fs").writeFileSync("pid", String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`;
    const parent = `
      require("node:child_process").spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(stubborn)}], { stdio: "ignore" });
      setTimeout(() => process.exit(0), 300);
    `;
    const result = await stubs(["run", "--", process.execPath, "-e", parent], "", { origin: false });
    expect(result.code).toBe(0);
    await sleep(50);
    expect(alive(Number(await readFile(join(cwd, "pid"), "utf8")))).toBe(false);
  }, 10_000);

  it.runIf(posix)("on SIGTERM, kills a command that ignores it once the grace runs out", async () => {
    await writeFile(join(cwd, ".env.local"), `CANARY_SECRET=${CANARY}\n`);
    const stubborn = `require("node:fs").writeFileSync("pid", String(process.pid)); process.on("SIGTERM", () => {}); console.log("up"); setInterval(() => {}, 1000)`;
    const child = track(spawn(process.execPath, [BIN, "run", "--", process.execPath, "-e", stubborn], { cwd, env: { ...process.env, XDG_CONFIG_HOME: xdg } }));
    await new Promise<void>((done) => child.stdout.once("data", () => done()));
    child.kill("SIGTERM");
    const code = await Promise.race([closed(child), sleep(5000).then(() => "hung")]);
    expect(code).toBe(128 + 9);
    expect(alive(Number(await readFile(join(cwd, "pid"), "utf8")))).toBe(false);
  }, 10_000);

  it.runIf(posix)("returns when a descendant that left the group holds the pipes, instead of waiting on it forever", async () => {
    await writeFile(join(cwd, ".env.local"), `CANARY_SECRET=${CANARY}\n`);
    const escaped = `require("node:fs").writeFileSync("pid", String(process.pid)); setInterval(() => {}, 1000)`;
    const parent = `
      require("node:child_process").spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(escaped)}], { detached: true, stdio: "inherit" });
      setTimeout(() => process.exit(0), 300);
    `;
    const child = track(spawn(process.execPath, [BIN, "run", "--", process.execPath, "-e", parent], { cwd, env: { ...process.env, XDG_CONFIG_HOME: xdg } }));
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await Promise.race([closed(child), sleep(6000).then(() => "hung")]);
    // The command's own exit was 0, and the run says why that isn't good enough.
    expect(code).toBe(125);
    expect(stderr).toBe("stubs: Something the command started kept its output open after the command exited. The run stopped waiting for it and dropped what was left.\n");
    // The escaped process is out of the group's reach: a documented limit. The teardown kills it.
    expect(alive(Number(await readFile(join(cwd, "pid"), "utf8")))).toBe(true);
  }, 10_000);

  it.runIf(hasGit)("refuses a stub that would make git run a command, before git ever starts", async () => {
    const marker = join(cwd, "executed");
    await writeFile(
      join(cwd, ".env.local"),
      `GIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=core.sshCommand\nGIT_CONFIG_VALUE_0='touch ${marker}; false'\n`,
    );
    const result = await stubs(["run", "--", "git", "ls-remote", "ssh://example.invalid/repo"], "", { origin: false });
    expect(result.code).toBe(125);
    expect(result.stderr).toContain("GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0 can't come from an env file");
    expect(await stat(marker).then(() => true, () => false)).toBe(false);
  });

  it("passes stdin through and keeps the command's exit code", async () => {
    await writeFile(join(cwd, ".env.local"), `CANARY_SECRET=${CANARY}\n`);
    const echo = `process.stdin.pipe(process.stdout); process.stdin.on("end", () => process.exit(4))`;
    const result = await stubs(["run", "--", process.execPath, "-e", echo], `typed ${CANARY}\n`, { origin: false });
    expect(result).toEqual({ code: 4, stdout: "typed [stubs:CANARY_SECRET]\n", stderr: "" });
  });
});

describe("stubs mcp over stdio", () => {
  /** Sends JSON-RPC lines to `stubs mcp` and returns the raw stdout once `id` answers. */
  function mcpExchange(messages: object[], waitForId: number, envOverrides: NodeJS.ProcessEnv = {}): Promise<string> {
    return new Promise((done, failed) => {
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdg, ...envOverrides };
      const child = track(spawn(process.execPath, [BIN, "mcp"], { cwd, env }));
      let stdout = "";
      const timer = setTimeout(() => {
        child.kill();
        failed(new Error(`no response to ${waitForId}: ${stdout}`));
      }, 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.split("\n").some((line) => line.includes(`"id":${waitForId}`))) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          done(stdout);
        }
      });
      child.on("error", failed);
      for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  it("rejects an outside default env symlink over stdio without a claim or file mutation", async () => {
    const outside = join(await tempDir(), "private.env");
    await writeFile(outside, "PRIVATE=unchanged\n");
    await symlink(outside, join(cwd, ".env.local"));
    const link = await server.seed(STUB, http.origin);
    const stdout = await mcpExchange(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pull_stub", arguments: { link } } },
      ],
      2,
      { STUBS_ORIGIN: http.origin },
    );
    const response = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === 2);
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(response.result.content[0].text)).toMatchObject({ ok: false, code: "invalid" });
    expect(stdout).not.toContain(CANARY);
    expect(stdout).not.toContain(link.split("#")[1]);
    expect(server.sent).toEqual([]);
    expect(server.store.size).toBe(1);
    expect(await readFile(outside, "utf8")).toBe("PRIVATE=unchanged\n");
  });

  it("redacts a link sent as a tool name out of the SDK's error", async () => {
    const link = await server.seed(STUB, http.origin);
    const fragment = link.slice(link.indexOf("#") + 1);
    const stdout = await mcpExchange(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: link, arguments: {} } },
      ],
      2,
    );
    const response = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((message) => message.id === 2);
    expect(JSON.stringify(response)).toContain("<redacted>");
    expect(stdout).not.toContain(fragment.slice(3, 23));
    expect(stdout).not.toContain(http.origin);
    expect(stdout).not.toContain("127.0.0.1");
    expect(server.store.size).toBe(1);
  });
});

describe("stubs binary", () => {
  it("prints usage for every command", async () => {
    const { stdout } = await exec(process.execPath, [BIN, "--help"]);
    for (const command of ["stubs pull", "stubs run", "stubs check", "stubs push", "stubs init", "stubs id", "stubs mcp", "stubs skill"]) {
      expect(stdout).toContain(command);
    }
  });

  it("never echoes a link passed as a path or a flag", async () => {
    const link = await server.seed(STUB, http.origin);
    const fragment = link.slice(link.indexOf("#") + 1);
    const runs = [
      await stubs(["push", link]),
      await stubs(["push", link, "--json"]),
      await stubs(["pull", link, "--to", link]),
      await stubs(["pull", link, "--to", link, "--json"]),
      await stubs(["pull", link, `--${fragment.slice(3)}`]),
      await stubs(["pull", link, `--${fragment.slice(3)}`, "--json"]),
    ];
    for (const result of runs) {
      expect(result.code).toBe(3);
      for (const stream of [result.stdout, result.stderr]) {
        expect(stream).not.toContain(fragment.slice(3, 23));
        expect(stream).not.toContain(CANARY);
      }
    }
    expect(server.store.size).toBe(1);
  });

  it("installs the skill under HOME without touching the real home", async () => {
    const realSkill = join(homedir(), ".claude/skills/stubs/SKILL.md");
    const before = await stat(realSkill).then((entry) => entry.mtimeMs, () => null);
    const fakeHome = await tempDir();
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
    delete env.CODEX_HOME;
    const { stdout } = await exec(process.execPath, [BIN, "skill", "install", "--target", "claude"], { cwd, env });
    expect(stdout).toBe("Installed for Claude Code: ~/.claude/skills/stubs/SKILL.md\n");
    const installed = await readFile(join(fakeHome, ".claude/skills/stubs/SKILL.md"), "utf8");
    const { stdout: shown } = await exec(process.execPath, [BIN, "skill", "show"], { cwd, env });
    expect(installed).toBe(shown);
    const { version } = JSON.parse(await readFile(join(ROOT, "cli/package.json"), "utf8"));
    expect(installed).toContain(`npx -y --loglevel=warn -- @talix/stubs@${version} pull`);
    expect(await stat(realSkill).then((entry) => entry.mtimeMs, () => null)).toBe(before);
  });

  it("bundles every dependency, so the pinned version is the whole supply chain", async () => {
    const bundle = await readFile(BIN, "utf8");
    const specifiers = [...bundle.matchAll(/\b(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s.startsWith("node:"))).toEqual([]);
    const pkg = JSON.parse(await readFile(join(ROOT, "cli/package.json"), "utf8"));
    expect(pkg.dependencies).toBeUndefined();
  });

  it("exits 3 on an unknown flag", async () => {
    expect((await stubs(["pull", "--nope"])).code).toBe(3);
  });

  it("prints one fixed line on a crash, never the error or a stack trace", async () => {
    const preload = join(cwd, "throw.cjs");
    await writeFile(preload, `setImmediate(() => { throw new Error("leaked ${CANARY}"); });`);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
      const child = track(spawn(process.execPath, ["--require", preload, BIN, "id"], { cwd, env: { ...process.env, XDG_CONFIG_HOME: xdg } }));
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (code) => done({ code, stdout, stderr }));
    });
    expect(result.code).toBe(1);
    // `id` may finish its read before the immediate fires, so its own line can come first.
    expect(result.stderr.endsWith("stubs: unexpected error.\n")).toBe(true);
    expect(result.stdout + result.stderr).not.toMatch(/leaked|Error|    at /);
  });

  it("pushes from stdin and pulls the result back with real fetch", async () => {
    const pushed = await stubs(["push", "-", "--json"], "A=1\n");
    expect(pushed.code).toBe(0);
    const { link } = JSON.parse(pushed.stdout);
    expect((await stubs(["check", link])).stdout).toMatch(/^Sealed\./);
    expect((await pullClean(link)).code).toBe(0);
    expect((await stubs(["check", link, "--json"])).code).toBe(2);
  });
});
