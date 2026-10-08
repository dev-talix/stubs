import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { isRefusedKey, loadEnvFiles, runCommand, type RunDeps } from "../src/run";
import { fakeServer } from "./helpers/fake-server";
import { runCli } from "./helpers/run";
import { alive, useLeftoverKiller } from "./helpers/leftovers";
import { useTempDirs } from "./helpers/temp";

const tempDir = useTempDirs();
useLeftoverKiller(() => cwd);
const NODE = process.execPath;
const SECRET = "hunter2-9f3a";
const DB_URL = "postgres://app:s3cretpw@db.internal:5432/app";
const posix = process.platform !== "win32";

let cwd: string;
beforeEach(async () => {
  cwd = await tempDir();
  await writeFile(join(cwd, ".env.local"), `API_KEY=${SECRET}\nDB_URL='${DB_URL}'\nPORT=3000\nDEBUG=true\n`);
});

const run = (args: string[], options: { env?: Record<string, string> } = {}) =>
  runCli(["run", ...args], { server: fakeServer(), cwd, ...options });
/** `stubs run -- node -e <script>` with the given extra arguments. */
const node = (script: string, ...args: string[]) => run(["--", NODE, "-e", script, ...args]);
const discard = () => new Writable({ write: (_c, _e, cb) => cb() });
/** Deps for calling runCommand directly, with the streams a test wants to control. */
const deps = (over: Partial<RunDeps> = {}): RunDeps => ({ cwd, env: {}, stdout: discard(), stderr: discard(), stdin: "ignore", warn: () => {}, ...over });
/** For a command that must not outlive the test: the teardown kills whatever pid is in `pid`. */
const WRITE_PID = `require("node:fs").writeFileSync("pid", String(process.pid));`;

describe("stubs run", () => {
  it("passes the values to the command and masks them in both streams", async () => {
    const result = await node(`
      console.log("key", process.env.API_KEY, "url", process.env.DB_URL, "port", process.env.PORT);
      console.error("again: " + process.env.API_KEY);
      process.exit(7);
    `);
    expect(result).toEqual({
      code: 7,
      stdout: "key [stubs:API_KEY] url [stubs:DB_URL] port 3000\n",
      stderr: "again: [stubs:API_KEY]\n",
    });
    expect(await readdir(cwd)).toEqual([".env.local"]);
  });

  it("masks a value the command writes in pieces, however long the pause", async () => {
    const result = await node(`
      const key = process.env.API_KEY;
      process.stdout.write("a=" + key.slice(0, 4));
      setTimeout(() => { process.stdout.write(key.slice(4) + "\\n"); }, 150);
    `);
    expect(result).toMatchObject({ code: 0, stdout: "a=[stubs:API_KEY]\n" });
  });

  it("holds a tail that could start a value until the command exits, with no timer to let it out", async () => {
    await writeFile(join(cwd, ".env.local"), "PROMPT_LIKE=Passw0rd-xyz\n");
    let seen = "";
    const stdout = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        seen += chunk.toString();
        callback();
      },
    });
    const code = await runCommand(
      { command: [NODE, "-e", `${WRITE_PID} process.stdout.write("Passw"); setTimeout(() => process.stdout.write("0rd-xyz\\n"), 400)`] },
      deps({ stdout }),
    );
    expect(code).toBe(0);
    expect(seen).toBe("[stubs:PROMPT_LIKE]\n");
  });

  it("masks a value split across chunks while the reader is slow", async () => {
    await writeFile(join(cwd, ".env.local"), `API_KEY=${SECRET}\n`);
    let seen = "";
    const slow = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        seen += chunk.toString();
        setTimeout(callback, 120);
      },
    });
    const script = `
      process.stdout.write("x".repeat(200000) + "hunte");
      setTimeout(() => process.stdout.write("r2-9f3a\\n"), 5);
    `;
    const code = await runCommand({ command: [NODE, "-e", script] }, deps({ stdout: slow }));
    expect(code).toBe(0);
    expect(seen).not.toContain(SECRET);
    expect(seen.endsWith("[stubs:API_KEY]\n")).toBe(true);
  }, 20_000);

  it("stops the command when the reader goes away, even one that ignores the write error", async () => {
    await writeFile(join(cwd, ".env.local"), `API_KEY=${SECRET}\n`);
    let writes = 0;
    const gone = new Writable({
      write(_chunk, _encoding, callback) {
        callback(++writes > 2 ? Object.assign(new Error("EPIPE"), { code: "EPIPE" }) : null);
      },
    });
    const script = `
      ${WRITE_PID}
      process.stdout.on("error", () => {});
      setInterval(() => process.stdout.write(process.env.API_KEY + "\\n"), 5);
    `;
    const code = await runCommand({ command: [NODE, "-e", script] }, deps({ stdout: gone }));
    expect(code).toBe(128 + 13);
  }, 10_000);

  it.runIf(posix)("stops what the command leaves behind, so nothing holding the values outlives it", async () => {
    await writeFile(join(cwd, ".env.local"), `API_KEY=${SECRET}\n`);
    // The shell exits at once; the grandchild would run for a minute holding our output pipe.
    const script = `${JSON.stringify(NODE)} -e "setTimeout(() => {}, 60000)" & echo $! > pid; sleep 0.1`;
    const code = await runCommand({ command: ["sh", "-c", script] }, deps());
    expect(code).toBe(0);
    const pid = Number((await readFile(join(cwd, "pid"), "utf8")).trim());
    await sleep(50);
    expect(alive(pid)).toBe(false);
  }, 10_000);

  it("masks every form the command might print a value in", async () => {
    const result = await node(`
      const url = process.env.DB_URL;
      console.log(JSON.stringify({ url }));
      console.log(encodeURIComponent(url));
      console.log(Buffer.from(url).toString("base64"));
      console.log("Authorization: Basic " + Buffer.from("app:" + process.env.API_KEY).toString("base64"));
    `);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("s3cretpw");
    expect(result.stdout).not.toContain("db.internal");
    expect(result.stdout).not.toContain(Buffer.from(`app:${SECRET}`).toString("base64").slice(4, -4));
    expect(result.stdout.split("[stubs:DB_URL]")).toHaveLength(4);
    expect(result.stdout).toContain("[stubs:API_KEY]");
  });

  it("masks a value JSON-escaped the way Python and Go write it, and with upper-case hex", async () => {
    await writeFile(join(cwd, ".env.local"), "API_KEY='pässw<&>örd-123'\n");
    const result = await node(`
      const json = JSON.stringify({ key: process.env.API_KEY });
      const esc = (upper) => (c) => { const hex = c.charCodeAt(0).toString(16).padStart(4, "0"); return "\\\\u" + (upper ? hex.toUpperCase() : hex); };
      console.log(json.replace(/[\\u0080-\\uffff]/g, esc(false)));        // Python json.dumps
      console.log(json.replace(/[<>&]/g, esc(false)));                     // Go encoding/json
      console.log(json.replace(/[\\u0080-\\uffff<>&]/g, esc(true)));      // both, upper-case hex
    `);
    expect(result.stdout).toBe('{"key":"[stubs:API_KEY]"}\n'.repeat(3));
  });

  it("masks values kept as comments by pull and malformed lines, so dumping the file shows no value", async () => {
    await writeFile(
      join(cwd, ".env.local"),
      `API_KEY=${SECRET}\n# stubs skipped (already set): OLD_KEY=old-value-123\n# stubs held back ($ reference): PUB='$OLD_KEY/suffix'\n# unparsed: not a pair ${SECRET}xyz\nBAD="unclosed ${SECRET}\n`,
    );
    const result = await node(`process.stdout.write(require("node:fs").readFileSync(".env.local", "utf8"))`);
    expect(result.stdout).toBe(
      "API_KEY=[stubs:API_KEY]\n# stubs skipped (already set): OLD_KEY=[stubs:OLD_KEY]\n# stubs held back ($ reference): PUB='[stubs:PUB]'\n# unparsed: [stubs:unparsed]\n[stubs:unparsed]\n",
    );
  });

  it("masks every value of a key set more than once, in one file or across files", async () => {
    await writeFile(join(cwd, ".env.local"), `API_KEY=old-secret-123\nAPI_KEY=${SECRET}\n`);
    await writeFile(join(cwd, "more.env"), "API_KEY=newer-secret-456\n");
    const dump = `
      const fs = require("node:fs");
      console.log(process.env.API_KEY);
      process.stdout.write(fs.readFileSync(".env.local", "utf8") + fs.readFileSync("more.env", "utf8"));
    `;
    const result = await run(["--from", ".env.local", "--from", "more.env", "--", NODE, "-e", dump]);
    expect(result.stdout).toBe("[stubs:API_KEY]\nAPI_KEY=[stubs:API_KEY]\nAPI_KEY=[stubs:API_KEY]\nAPI_KEY=[stubs:API_KEY]\n");
  });

  it("refuses to run when the file names a key the environment already sets", async () => {
    const result = await run(["--", NODE, "-e", "console.log('ran')"], { env: { API_KEY: "from-the-shell" } });
    expect(result).toEqual({
      code: 125,
      stdout: "",
      stderr: "stubs: Already set in your environment with a different value: API_KEY. Unset it (env -u KEY) or take it out of the file, so the command gets one value.\n",
    });
  });

  it("accepts a key the environment sets to the same value", async () => {
    const result = await run(["--", NODE, "-e", "console.log(process.env.API_KEY)"], { env: { API_KEY: SECRET } });
    expect(result).toEqual({ code: 0, stdout: "[stubs:API_KEY]\n", stderr: "" });
  });

  it("refuses to run when the file sets keys that change which code programs run", async () => {
    await writeFile(join(cwd, ".env.local"), `NODE_OPTIONS=--require /tmp/evil.js\nnpm_config_node_options=--require /tmp/evil.js\nGIT_CONFIG_COUNT=1\nZDOTDIR=/tmp\nOK=fine-value\n`);
    const result = await node(`console.log("ran")`);
    expect(result).toEqual({
      code: 125,
      stdout: "",
      stderr:
        "stubs: NODE_OPTIONS, npm_config_node_options, GIT_CONFIG_COUNT, ZDOTDIR can't come from an env file: keys like that change which code programs run. Take them out of the file, or set them in your shell on purpose.\n",
    });
  });

  it("reads other files with --from, in order", async () => {
    await writeFile(join(cwd, "a.env"), "A=aaaaaa\nB=first-b\n");
    await writeFile(join(cwd, "b.env"), "C=second-c\n");
    const result = await run(["--from", "a.env", "--from", "b.env", "--", NODE, "-e", "console.log(process.env.A, process.env.B, process.env.C, process.env.API_KEY)"]);
    expect(result.stdout).toBe("[stubs:A] [stubs:B] [stubs:C] undefined\n");
  });

  it("exits 125 without running when the env file is missing", async () => {
    expect(await run(["--from", "nope.env", "--", NODE, "-e", "console.log('ran')"])).toEqual({
      code: 125,
      stdout: "",
      stderr: "stubs: The --from file doesn't exist. Pull a stub first, or check --from.\n",
    });
    expect(await run(["--from", ".env.local", "--from", "nope.env", "--", NODE, "-e", "console.log('ran')"])).toMatchObject({
      code: 125,
      stderr: "stubs: --from file number 2 doesn't exist. Pull a stub first, or check --from.\n",
    });
  });

  it("points --env-file at --from, since Node claims that flag before stubs runs", async () => {
    await writeFile(join(cwd, "harmless.env"), "X=1\n");
    for (const args of [["--env-file", "harmless.env"], ["--env-file=harmless.env"], ["--env-file-if-exists", "harmless.env"]]) {
      const result = await run([...args, "--", NODE, "-e", "console.log('ran')"]);
      expect(result.code).toBe(125);
      expect(result.stderr).toBe(
        "stubs: stubs run doesn't take --env-file: that's a Node flag, and Node would read the file itself. Use --from <file>. Run `stubs run --help`.\n",
      );
    }
  });

  it("never echoes the command or a file name, since either could be a value", async () => {
    await writeFile(join(cwd, SECRET), "NODE_OPTIONS=--require /tmp/evil.js\n");
    const results = [
      await run(["--", SECRET]),
      await run(["--from", `${SECRET}.missing`, "--", NODE, "-e", "1"]),
      await run(["--from", SECRET, "--", NODE, "-e", "1"]),
      await run(["--from", SECRET, "--from", ".env.local", "--", NODE, "-e", "1"]),
    ];
    expect(results.map((result) => result.code)).toEqual([127, 125, 125, 125]);
    for (const result of results) expect(result.stdout + result.stderr).not.toContain(SECRET);
  });

  it("exits 127 when the command isn't found, and 125 with nothing after --", async () => {
    expect(await run(["--", "definitely-not-a-command-xyz"])).toMatchObject({ code: 127, stderr: "stubs: Command not found.\n" });
    expect(await run(["--"])).toMatchObject({ code: 125, stderr: expect.stringContaining("Nothing to run") });
    expect(await run([])).toMatchObject({ code: 125 });
  });

  it("asks for -- when the command's flags land on stubs", async () => {
    const result = await run([NODE, "-e", "1"]);
    expect(result.code).toBe(125);
    expect(result.stderr).toContain("Put -- before the command");
  });

  it("passes flags after -- to the command, including --json and --help", async () => {
    const result = await node(`console.log(process.argv.slice(1).join(" "))`, "--", "--json", "--help", "--from", "x");
    expect(result).toMatchObject({ code: 0, stdout: "--json --help --from x\n" });
  });

  it("reports a signal the way a shell does", async () => {
    const result = await node(`${WRITE_PID} process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 5000)`);
    expect(result.code).toBe(128 + 15);
  });

  it("surfaces a relay failure that isn't a closed reader, after stopping a command that shrugs it off", async () => {
    await writeFile(join(cwd, ".env.local"), `API_KEY=${SECRET}\n`);
    const full = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
      },
    });
    // Handles its stdout error and SIGTERM, so only the grace-then-SIGKILL path ends it.
    const script = `${WRITE_PID} process.stdout.on("error", () => {}); process.on("SIGTERM", () => {}); console.log("line"); setInterval(() => {}, 1000)`;
    const started = Date.now();
    await expect(runCommand({ command: [NODE, "-e", script] }, deps({ stdout: full }))).rejects.toMatchObject({ code: "ENOSPC" });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(alive(Number(await readFile(join(cwd, "pid"), "utf8")))).toBe(false);
  }, 10_000);

  it("keeps waiting while output is queued behind a slow reader, and returns right after a quick one", async () => {
    await writeFile(join(cwd, ".env.local"), `API_KEY=${SECRET}\n`);
    let seen = 0;
    const slow = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        seen += chunk.length;
        setTimeout(callback, 800);
      },
    });
    const script = `process.stdout.write("z".repeat(300000), () => process.stdout.write("DONE\\n", () => process.exit(7)))`;
    const warnings: string[] = [];
    const code = await runCommand({ command: [NODE, "-e", script] }, deps({ stdout: slow, warn: (message) => warnings.push(message) }));
    expect(code).toBe(7);
    expect(seen).toBe(300005);
    expect(warnings).toEqual([]);

    const started = Date.now();
    expect(await runCommand({ command: [NODE, "-e", "process.exit(3)"] }, deps())).toBe(3);
    expect(Date.now() - started).toBeLessThan(1000);
  }, 20_000);

  it("has no flag that shows the values", async () => {
    const result = await run(["--unmasked", "--", NODE, "-e", "console.log(process.env.API_KEY)"]);
    expect(result.code).toBe(125);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(result.stderr).toContain("unknown flag");
  });

  it("warns when the file sets nothing", async () => {
    await writeFile(join(cwd, ".env.local"), "# empty\n");
    const result = await node(`console.log("ran")`);
    expect(result).toEqual({ code: 0, stdout: "ran\n", stderr: "stubs: The env file set no values for the command.\n" });
  });
});

describe("isRefusedKey", () => {
  it.each([
    "PATH", "HOME", "SHELL", "ENV", "BASH_ENV", "ZDOTDIR", "IFS", "PS4", "PAGER", "EDITOR", "LESSOPEN", "XDG_CONFIG_HOME",
    "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "NODE_PATH", "npm_config_node_options", "NPM_CONFIG_REGISTRY",
    "PYTHONPATH", "PYTHONSTARTUP", "PERL5OPT", "RUBYOPT", "GEM_PATH", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND", "GIT_EXEC_PATH",
    "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "DOTNET_STARTUP_HOOKS", "ld_preload", "Path",
  ])("refuses %s", (key) => {
    expect(isRefusedKey(key)).toBe(true);
  });

  it.each(["NODE_ENV", "API_KEY", "DATABASE_URL", "PORT", "GITHUB_TOKEN", "NEXT_PUBLIC_URL", "PATHWAY"])("allows %s", (key) => {
    expect(isRefusedKey(key)).toBe(false);
  });
});

describe("loadEnvFiles", () => {
  it("collects a needle for every value in the files before deciding which one the command gets", async () => {
    await writeFile(join(cwd, ".env.local"), `API_KEY=old-secret-123\nAPI_KEY=${SECRET}\nPORT=3000\n`);
    const loaded = await loadEnvFiles([".env.local"], { cwd, env: {} });
    if ("ok" in loaded) throw new Error(loaded.message);
    expect(loaded.values).toEqual(new Map([["API_KEY", SECRET], ["PORT", "3000"]]));
    const texts = loaded.needles.map((n) => n.bytes.toString());
    expect(texts).toContain("old-secret-123");
    expect(texts).toContain(SECRET);
    expect(texts).not.toContain("3000");
  });
});
