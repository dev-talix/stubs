import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { generateIdentity, PUBLIC_ID_PATTERN } from "../../src/core/lock";
import { probeGit, type GitRunner } from "../src/git-guard";
import { createIdentity } from "../src/identity";
import { pullStub } from "../src/pull";
import { fakeServer, type FakeServer } from "./helpers/fake-server";
import { ORIGIN, runCli } from "./helpers/run";
import { useTempDirs } from "./helpers/temp";

const exec = promisify(execFile);
const tempDir = useTempDirs();
const STUB = "API_KEY=sk-123\nDB_URL=postgres://u:p@h/db\nSECRET=two words";

let server: FakeServer;
let cwd: string;
beforeEach(async () => {
  server = fakeServer();
  cwd = await tempDir();
});

const pull = (...args: string[]) => runCli(["pull", ...args], { server, cwd });
const envFile = (name = ".env.local") => readFile(join(cwd, name), "utf8");

describe("pull", () => {
  it("writes a 0600 file and reports key names only", async () => {
    const link = await server.seed(STUB, ORIGIN);
    const result = await pull(link);
    expect(result).toEqual({
      code: 0,
      stdout: "Pulled 3 values into .env.local: API_KEY, DB_URL, SECRET\n",
      stderr: "",
    });
    expect(await envFile()).toBe("API_KEY=sk-123\nDB_URL=postgres://u:p@h/db\nSECRET='two words'\n");
    expect((await stat(join(cwd, ".env.local"))).mode & 0o777).toBe(0o600);
  });

  it("prints one JSON object with --json", async () => {
    const link = await server.seed(STUB, ORIGIN);
    const result = await pull(link, "--json", "--to", "custom.env");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      file: "custom.env",
      written: ["API_KEY", "DB_URL", "SECRET"],
      skipped: [],
      held: [],
      unparsed: 0,
      warnings: [],
    });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(await envFile("custom.env")).toContain("API_KEY=sk-123");
  });

  it("reports void on a second pull", async () => {
    const link = await server.seed(STUB, ORIGIN);
    await pull(link);
    const second = await pull(link, "--json", "--to", "other.env");
    expect(second.code).toBe(2);
    expect(JSON.parse(second.stdout)).toMatchObject({ ok: false, code: "void" });
    await expect(stat(join(cwd, "other.env"))).rejects.toThrow();
  });

  it("skips existing keys and keeps their values", async () => {
    const before = "# mine\nAPI_KEY=old\n";
    await writeFile(join(cwd, ".env.local"), before);
    const link = await server.seed(STUB, ORIGIN);
    const result = await pull(link);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "Pulled 2 values into .env.local: DB_URL, SECRET\nSkipped 1 existing key: API_KEY\n",
    );
    const after = await envFile();
    expect(after.startsWith(before)).toBe(true);
    // The pulled value is kept, but only as a comment: the existing value still wins.
    expect(after.slice(before.length)).toBe(
      "DB_URL=postgres://u:p@h/db\nSECRET='two words'\n# stubs skipped (already set): API_KEY=sk-123\n",
    );
  });

  it("replaces existing values with --overwrite", async () => {
    await writeFile(join(cwd, ".env.local"), "# mine\nAPI_KEY=old\nOTHER=1\n");
    const link = await server.seed(STUB, ORIGIN);
    const result = await pull(link, "--overwrite", "--json");
    expect(JSON.parse(result.stdout)).toMatchObject({ written: ["API_KEY", "DB_URL", "SECRET"], skipped: [] });
    expect(await envFile()).toBe(
      "# mine\nAPI_KEY=sk-123\nOTHER=1\nDB_URL=postgres://u:p@h/db\nSECRET='two words'\n",
    );
  });

  it("keeps unparsed lines as comments and counts them", async () => {
    const link = await server.seed("A=1\nsomething odd\n", ORIGIN);
    const result = await pull(link);
    expect(result.stdout).toBe("Pulled 1 value into .env.local: A\nKept 1 unparsed line as comments in .env.local.\n");
    expect(await envFile()).toBe("A=1\n# unparsed: something odd\n");
  });

  it.each([false, true])("explains a plain-text pull without printing it, json=%s", async (json) => {
    const text = "sk_live_abc123\nsecond-secret-line";
    const link = await server.seed(text, ORIGIN);
    const file = json ? "custom.env" : ".env.local";
    const result = await pull(link, "--to", file, ...(json ? ["--json"] : []));
    const message = `The stub had no KEY=value lines. Its text was saved as a comment in ${file}.`;
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    if (json) {
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true, written: [], skipped: [], held: [], unparsed: 2, message,
      });
    } else {
      expect(result.stdout).toBe(message + "\n");
    }
    for (const value of text.split("\n")) expect(result.stdout + result.stderr).not.toContain(value);
    expect(await envFile(file)).toBe("# unparsed: sk_live_abc123\n# unparsed: second-secret-line\n");
    expect(server.store.size).toBe(0);
    expect((await pull(link)).code).toBe(2);
  });

  it("does not claim to save comments-only text", async () => {
    const link = await server.seed("# just a comment\n", ORIGIN);
    const result = await pull(link);
    expect(result).toEqual({
      code: 0,
      stdout: "The stub had no KEY=value lines. There were only comments or blank lines, so nothing was written.\n",
      stderr: "",
    });
    expect(await readdir(cwd)).toEqual([]);
  });

  it("does not mistake skipped or held pairs for plain text", async () => {
    await writeFile(join(cwd, ".env.local"), "PORT=3000\n");
    const link = await server.seed("PORT=4000\nREF=$OTHER\nstray text", ORIGIN);
    const result = await pull(link, "--json");
    expect(JSON.parse(result.stdout)).toMatchObject({ written: [], skipped: ["PORT"], held: ["REF"], unparsed: 1 });
    expect(JSON.parse(result.stdout)).not.toHaveProperty("message");
  });

  it("exits 6 when the stub won't decrypt", async () => {
    const link = await server.seed(STUB, ORIGIN);
    server.tamperAll();
    const result = await pull(link, "--json");
    expect(result.code).toBe(6);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "tampered" });
    expect(await readdir(cwd)).toEqual([]);
  });

  it("exits 7 when the claim gets no response", async () => {
    const link = await server.seed(STUB, ORIGIN);
    server.dropClaims = true;
    const result = await pull(link);
    expect(result.code).toBe(7);
    expect(result.stderr).toContain("may or may not have been opened");
  });

  it("exits 4 when rate limited, without consuming", async () => {
    const link = await server.seed(STUB, ORIGIN);
    server.rateLimited = true;
    expect((await pull(link)).code).toBe(4);
    expect(server.store.size).toBe(1);
  });

  it("refuses another origin with exit 3 and no network call", async () => {
    const link = await server.seed(STUB, "https://evil.example");
    const result = await pull(link);
    expect(result.code).toBe(3);
    expect(server.sent).toEqual([]);
  });

  it("trusts another origin given by --origin or STUBS_ORIGIN", async () => {
    const link = await server.seed(STUB, "http://127.0.0.1:9999");
    expect((await pull(link, "--origin", "http://127.0.0.1:9999")).code).toBe(0);
    const again = await server.seed("B=2", "http://127.0.0.1:9999");
    const viaEnv = await runCli(["pull", again], { server, cwd, env: { STUBS_ORIGIN: "http://127.0.0.1:9999" } });
    expect(viaEnv.code).toBe(0);
  });

  it("exits 3 for a missing folder before claiming", async () => {
    const link = await server.seed(STUB, ORIGIN);
    expect((await pull(link, "--to", "nope/.env")).code).toBe(3);
    expect(server.sent).toEqual([]);
  });

  it("refuses a file git wouldn't ignore with exit 5 before claiming", async () => {
    await exec("git", ["init", "-q"], { cwd });
    const link = await server.seed(STUB, ORIGIN);
    const result = await pull(link);
    expect(result.code).toBe(5);
    expect(result.stderr).toContain("Add `.env.local` to .gitignore");
    expect(server.sent).toEqual([]);

    expect((await pull(link, "--allow-tracked")).code).toBe(0);
    await writeFile(join(cwd, ".gitignore"), ".env.local\n");
    const ignored = await server.seed("C=3", ORIGIN);
    expect((await pull(ignored, "--to", ".env.local")).code).toBe(0);
  });

  it("saves the values under the config dir, not beside the target, when the write fails", async () => {
    await exec("git", ["init", "-q"], { cwd });
    await writeFile(join(cwd, ".gitignore"), ".env.local\n");
    await writeFile(join(cwd, ".env.local"), "OLD=1\n");
    const link = await server.seed(STUB, ORIGIN);
    // The target turns into a folder between the pre-claim checks and the write.
    server.onClaim = async () => {
      await rm(join(cwd, ".env.local"));
      await mkdir(join(cwd, ".env.local", "inside"), { recursive: true });
    };
    const xdg = await tempDir();
    const result = await runCli(["pull", link, "--json"], { server, cwd, env: { XDG_CONFIG_HOME: xdg } });
    expect(result.code).toBe(1);
    const failure = JSON.parse(result.stdout);
    const dir = join(xdg, "stubs", "recovered");
    expect(failure).toMatchObject({ ok: false, code: "error" });
    expect(failure.recoveredFile.startsWith(dir + "/")).toBe(true);
    expect(failure.recoveredFile).toMatch(/\/\d{4}-\d\d-\d\dT[\d-]+\.\d{3}Z-\.env\.local-[0-9a-f]{6}$/);
    expect(failure.message).toContain(failure.recoveredFile);
    expect(await readFile(failure.recoveredFile, "utf8")).toBe(STUB);
    expect((await stat(failure.recoveredFile)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    // Nothing new in the repo: no recovery file and no leftover temp file.
    expect((await readdir(cwd)).sort()).toEqual([".env.local", ".git", ".gitignore"]);
  });

  it.skipIf(process.getuid?.() === 0)("says the values are lost when even recovery fails", async () => {
    const link = await server.seed(STUB, ORIGIN);
    server.onClaim = () => chmod(cwd, 0o500);
    try {
      const result = await pull(link);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("values are lost");
    } finally {
      await chmod(cwd, 0o700);
    }
  });

  it.each([
    [["--bogus"], 3],
    [[], 3],
    [["a", "b"], 3],
    [["--to"], 3],
  ])("exits 3 for bad arguments %j", async (args, code) => {
    expect((await pull(...args)).code).toBe(code);
  });

  it("works as a plain function with injected dependencies", async () => {
    const link = await server.seed("A=1", ORIGIN);
    const result = await pullStub(
      { link, origin: ORIGIN },
      {
        transport: server.transport,
        cwd,
        identity: { env: {}, home: cwd },
        probeGit: async () => ({ kind: "no_repo" }),
      },
    );
    expect(result).toEqual({ ok: true, file: ".env.local", written: ["A"], skipped: [], held: [], unparsed: 0, warnings: [] });
  });
});

describe("client header", () => {
  it("names the CLI on every request", async () => {
    const link = await server.seed(STUB, ORIGIN);
    expect((await runCli(["check", link], { server, cwd })).code).toBe(0);
    expect((await pull(link)).code).toBe(0);
    await writeFile(join(cwd, ".env.push"), "A=1\n");
    expect((await runCli(["push", ".env.push"], { server, cwd })).code).toBe(0);
    expect(server.clients.length).toBeGreaterThanOrEqual(3);
    expect(server.clients.every((client) => client === "cli")).toBe(true);
  });
});

describe("review probes", () => {
  const fragmentOf = (link: string) => link.slice(link.indexOf("#") + 1);
  const expectClean = (result: { stdout: string; stderr: string }, link: string) => {
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toContain(fragmentOf(link));
      expect(stream).not.toContain(fragmentOf(link).slice(3, 23));
      expect(stream).not.toContain("sk-123");
    }
  };

  it("push <link> doesn't echo the link as a path", async () => {
    const link = await server.seed(STUB, ORIGIN);
    for (const args of [["push", link], ["push", link, "--json"]]) {
      const result = await runCli(args, { server, cwd });
      expect(result.code).toBe(3);
      expectClean(result, link);
    }
  });

  it("refuses a link with shell metacharacters before any request", async () => {
    const link = await server.seed(STUB, ORIGIN);
    const result = await pull(`${link}'$(touch pwned)'`, "--json");
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout).message).toBe(
      "That isn't a plain Stubs link (stubs.talix.app/t#…). Nothing was consumed.",
    );
    expect(server.sent).toEqual([]);
    expect(server.store.size).toBe(1);
  });

  it("pull <link> --to <link> doesn't echo the link", async () => {
    const link = await server.seed(STUB, ORIGIN);
    for (const flags of [[], ["--json"]]) {
      const result = await pull(link, "--to", link, ...flags);
      expect(result.code).toBe(3);
      expectClean(result, link);
    }
    expect(server.store.size).toBe(1);
  });

  it("an unknown flag that looks like a key isn't reflected", async () => {
    const link = await server.seed(STUB, ORIGIN);
    const flag = `--${fragmentOf(link).slice(3)}`;
    for (const flags of [[], ["--json"]]) {
      const result = await pull(link, flag, ...flags);
      expect(result.code).toBe(3);
      expectClean(result, link);
      expect(result.stdout + result.stderr).toContain("was given an unknown flag");
    }
  });

  it("names a known flag used in the wrong command", async () => {
    const result = await runCli(["check", "x", "--overwrite"], { server, cwd });
    expect(result).toMatchObject({ code: 3, stderr: "stubs: stubs check doesn't take --overwrite. Run `stubs check --help`.\n" });
    const unknown = await runCli(["check", "x", "--nope"], { server, cwd });
    expect(unknown.stderr).toBe("stubs: stubs check was given an unknown flag. Run `stubs check --help`.\n");
  });

  it("refuses a symlinked .env.local that points at a tracked file", async () => {
    await exec("git", ["init", "-q"], { cwd });
    await exec("git", ["config", "user.email", "t@example.com"], { cwd });
    await exec("git", ["config", "user.name", "t"], { cwd });
    await writeFile(join(cwd, "config.env"), "X=1\n");
    await exec("git", ["add", "config.env"], { cwd });
    await exec("git", ["commit", "-qm", "c"], { cwd });
    await writeFile(join(cwd, ".gitignore"), ".env.local\n");
    await symlink("config.env", join(cwd, ".env.local"));
    const link = await server.seed(STUB, ORIGIN);
    const result = await pull(link);
    expect(result.code).toBe(5);
    expect(result.stderr).toBe(
      "stubs: .env.local points at config.env, which is tracked by git. From the repository root, run `git rm --cached config.env`, add `config.env` to .gitignore, then pull again (or pass --allow-tracked). Nothing was consumed.\n",
    );
    expect(server.sent).toEqual([]);
    expect(await readFile(join(cwd, "config.env"), "utf8")).toBe("X=1\n");
  });

  it("names a symlink's destination as the thing to ignore, and that fixes it", async () => {
    await exec("git", ["init", "-q"], { cwd });
    await mkdir(join(cwd, "app"));
    await mkdir(join(cwd, "shared"));
    await writeFile(join(cwd, ".gitignore"), ".env.local\n");
    await symlink(join("..", "shared", "real.env"), join(cwd, "app", ".env.local"));
    await writeFile(join(cwd, "shared", "real.env"), "");
    const link = await server.seed("A=1", ORIGIN);

    const refused = await pull(link, "--to", "app/.env.local");
    expect(refused.code).toBe(5);
    expect(refused.stderr).toContain("app/.env.local points at shared/real.env, which git would track.");
    expect(refused.stderr).toContain("Add `shared/real.env` to the .gitignore at the repository root");

    await writeFile(join(cwd, ".gitignore"), ".env.local\nshared/real.env\n");
    expect((await pull(link, "--to", "app/.env.local")).code).toBe(0);
    expect(await readFile(join(cwd, "shared", "real.env"), "utf8")).toBe("A=1\n");
  });

  it("writes through a symlink to an ignored file and keeps the link", async () => {
    await mkdir(join(cwd, "shared"));
    await writeFile(join(cwd, "shared", "real.env"), "X=1\n");
    await symlink(join("shared", "real.env"), join(cwd, ".env.local"));
    const link = await server.seed("A=1", ORIGIN);
    expect((await pull(link)).code).toBe(0);
    expect((await lstat(join(cwd, ".env.local"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(cwd, "shared", "real.env"), "utf8")).toBe("X=1\nA=1\n");
  });

  it("allows the CLI to choose an outside target or follow an outside symlink", async () => {
    const outside = await tempDir();
    const target = join(outside, "chosen.env");
    let link = await server.seed("A=1", ORIGIN);
    expect((await pull(link, "--to", target)).code).toBe(0);
    await symlink(target, join(cwd, ".env.local"));
    link = await server.seed("B=2", ORIGIN);
    expect((await pull(link)).code).toBe(0);
    expect(await readFile(target, "utf8")).toBe("A=1\nB=2\n");
    expect((await lstat(join(cwd, ".env.local"))).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("keeps the CLI permission error for an inaccessible outside target", async () => {
    const outside = await tempDir();
    const target = join(outside, "private.env");
    await writeFile(target, "PRIVATE=unchanged\n");
    await chmod(outside, 0o000);
    try {
      const link = await server.seed("A=1", ORIGIN);
      const result = await pull(link, "--to", target, "--json");
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "error" });
      expect(JSON.parse(result.stdout).message).toContain("EACCES");
      expect(server.sent).toEqual([]);
      expect(server.store.size).toBe(1);
    } finally {
      await chmod(outside, 0o700);
    }
    expect(await readFile(target, "utf8")).toBe("PRIVATE=unchanged\n");
    expect(await readdir(outside)).toEqual(["private.env"]);
  });

  describe("when git can't run", () => {
    const missingGit: GitRunner = async () => ({ code: "failed", stdout: "", stderr: "" });
    const pullWithoutGit = async (link: string) =>
      pullStub(
        { link, origin: ORIGIN },
        { transport: server.transport, cwd, identity: { env: {}, home: cwd }, probeGit: (file) => probeGit(file, missingGit) },
      );

    it("refuses inside a directory tree with a .git entry", async () => {
      await mkdir(join(cwd, ".git"));
      await mkdir(join(cwd, "app"));
      const link = await server.seed(STUB, ORIGIN);
      const result = await pullStub(
        { link, origin: ORIGIN, to: "app/.env.local" },
        { transport: server.transport, cwd, identity: { env: {}, home: cwd }, probeGit: (file) => probeGit(file, missingGit) },
      );
      expect(result).toEqual({
        ok: false,
        code: "refused",
        message:
          "Couldn't ask git whether app/.env.local is ignored; refusing to write inside a repository. Pass --allow-tracked to override.",
      });
      expect(server.sent).toEqual([]);
    });

    it("treats a tree with no .git as not a repo", async () => {
      const link = await server.seed("A=1", ORIGIN);
      expect(await pullWithoutGit(link)).toMatchObject({ ok: true, written: ["A"] });
    });

    it("refuses when git times out inside a repo", async () => {
      await mkdir(join(cwd, ".git"));
      const timedOut: GitRunner = async () => ({ code: "failed", stdout: "", stderr: "" });
      expect(await probeGit(join(cwd, ".env.local"), timedOut)).toEqual({ kind: "unknown" });
    });

    it("trusts git's own 'not a git repository' answer", async () => {
      await mkdir(join(cwd, ".git"));
      const notRepo: GitRunner = async () => ({
        code: 128,
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git",
      });
      expect(await probeGit(join(cwd, ".env.local"), notRepo)).toEqual({ kind: "no_repo" });
    });
  });

  it("keeps invalid UTF-8 bytes in the existing file through --overwrite", async () => {
    const bad = Buffer.from([0x42, 0x3d, 0xff, 0xfe, 0x0a]);
    await writeFile(join(cwd, ".env.local"), Buffer.concat([Buffer.from("API_KEY=old\n"), bad]));
    const link = await server.seed("API_KEY=new", ORIGIN);
    expect((await pull(link, "--overwrite")).code).toBe(0);
    expect(await readFile(join(cwd, ".env.local"))).toEqual(Buffer.concat([Buffer.from("API_KEY=new\n"), bad]));
  });

  it("warns, still writes, and exits 0 when the existing file is malformed", async () => {
    await writeFile(join(cwd, ".env.local"), 'A=1\nB="unclosed\n');
    const link = await server.seed("C=3", ORIGIN);
    const human = await pull(link);
    expect(human.code).toBe(0);
    expect(human.stderr).toBe(
      "stubs: warning: Line 2 of .env.local is malformed; a dotenv parser may not read the keys appended after it.\n",
    );
    expect(await envFile()).toBe('A=1\nB="unclosed\nC=3\n');

    const again = await server.seed("D=4", ORIGIN);
    const json = await pull(again, "--json");
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: true,
      written: ["D"],
      warnings: ["Line 2 of .env.local is malformed; a dotenv parser may not read the keys appended after it."],
    });
  });
});

describe("check", () => {
  const check = (...args: string[]) => runCli(["check", ...args], { server, cwd });

  it("reports sealed without consuming", async () => {
    const link = await server.seed(STUB, ORIGIN);
    const human = await check(link);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/^Sealed\. Valid until .+\.\n$/);
    expect(JSON.parse((await check(link, "--json")).stdout)).toEqual({
      ok: true,
      status: "sealed",
      expiresAt: 4_102_444_800_000,
    });
    expect(server.store.size).toBe(1);
  });

  it("reports void with exit 2", async () => {
    const link = await server.seed(STUB, ORIGIN);
    await pull(link);
    const human = await check(link);
    expect(human).toMatchObject({ code: 2, stdout: "Void (opened or expired).\n" });
    expect(JSON.parse((await check(link, "--json")).stdout)).toEqual({ ok: true, status: "void" });
  });

  it("exits 4 with no response", async () => {
    const link = await server.seed(STUB, ORIGIN);
    const result = await runCli(["check", link, "--json"], {
      server: { ...server, transport: () => Promise.reject(new TypeError("fetch failed")) },
      cwd,
    });
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "network" });
  });
});

describe("push", () => {
  const push = (args: string[], stdin?: string) => runCli(["push", ...args], { server, cwd, stdin });

  it("seals .env.local by default and prints a link that pulls", async () => {
    await writeFile(join(cwd, ".env.local"), "A=1\n");
    const result = await push([]);
    expect(result.code).toBe(0);
    const link = result.stdout.trim();
    expect(link).toMatch(/^https:\/\/stubs\.talix\.app\/t#v1\.[\w-]{43}$/);
    expect(result.stderr).toContain("Opens once");

    const target = await tempDir();
    expect((await runCli(["pull", link], { server, cwd: target })).code).toBe(0);
    expect(await readFile(join(target, ".env.local"), "utf8")).toBe("A=1\n");
  });

  it("reads stdin for - and prints JSON", async () => {
    const result = await push(["-", "--json", "--ttl", "5m"], "B=2\n");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, expiresAt: 4_102_444_800_000 });
    const created = JSON.parse(server.sent[1]!);
    expect(created.ttlSeconds).toBe(300);
  });

  it("defaults to a one-hour TTL", async () => {
    await writeFile(join(cwd, "x.env"), "A=1");
    await push(["x.env"]);
    expect(JSON.parse(server.sent[1]!).ttlSeconds).toBe(3600);
  });

  it.each(["2h", "1w", "0m", "60", ""])("refuses ttl %j with exit 3", async (ttl) => {
    await writeFile(join(cwd, ".env.local"), "A=1");
    expect((await push(["--ttl", ttl])).code).toBe(3);
    expect(server.sent).toEqual([]);
  });

  it("refuses empty input with exit 3", async () => {
    await writeFile(join(cwd, "empty.env"), "  \n");
    expect((await push(["empty.env"])).code).toBe(3);
    expect((await push(["-"], "")).code).toBe(3);
    expect(server.sent).toEqual([]);
  });

  it("refuses a missing file with exit 3", async () => {
    expect((await push(["missing.env"])).code).toBe(3);
  });

  it("wires --prompt to hidden input, preserving TTL, locking and JSON output", async () => {
    const recipient = await generateIdentity();
    let reads = 0;
    const result = await runCli(["push", "--prompt", "--ttl", "5m", "--to", recipient.publicId, "--json"], {
      server, cwd,
      readPrompt: async () => { reads++; return STUB; },
    });
    expect(reads).toBe(1);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, locked: true });
    expect(JSON.parse(server.sent[1]!).ttlSeconds).toBe(300);
    expect(await readdir(cwd)).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain("sk-123");
  });

  it.each([[["x.env"]], [["-"]], [["--ttl", "2h"]], [["--to", "bad-id"]]])(
    "rejects invalid --prompt arguments %j before asking or issuing", async (args) => {
      const result = await runCli(["push", "--prompt", ...args], {
        server, cwd,
        readPrompt: async () => { throw new Error("prompt must not run"); },
      });
      expect(result.code).toBe(3);
      expect(server.sent).toEqual([]);
    },
  );

  it.each(["", "  \n", "x".repeat(32 * 1024 + 1)])("refuses empty or oversized hidden input", async (input) => {
    const result = await runCli(["push", "--prompt"], { server, cwd, readPrompt: async () => input });
    expect(result.code).toBe(3);
    expect(server.sent).toEqual([]);
  });

  it("never issues or repeats an exception from hidden input", async () => {
    const result = await runCli(["push", "--prompt"], {
      server, cwd, readPrompt: async () => { throw new Error(STUB); },
    });
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("sk-123");
    expect(server.sent).toEqual([]);
  });
});

describe("locked stubs", () => {
  let home: string;
  let publicId: string;
  beforeEach(async () => {
    home = await tempDir();
    ({ publicId } = (await createIdentity({ env: {}, home })) as { publicId: string });
  });
  const cli = (args: string[], options: { home?: string; stdin?: string } = {}) =>
    runCli(args, { server, cwd, home, ...options });

  it("pulls and checks with the identity it's locked to", async () => {
    const link = await server.seed(STUB, ORIGIN, publicId);
    expect(link).toMatch(/\/t#v2\./);
    expect(JSON.parse((await cli(["check", link, "--json"])).stdout)).toMatchObject({ status: "sealed" });
    const result = await cli(["pull", link]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Pulled 3 values into .env.local: API_KEY, DB_URL, SECRET\n");
    expect(await envFile()).toContain("API_KEY=sk-123");
    expect((await cli(["pull", link, "--to", "again.env"])).code).toBe(2);
  });

  it.each(["pull", "check"])("%s exits 3 with no identity and makes no request", async (command) => {
    const link = await server.seed(STUB, ORIGIN, publicId);
    const result = await cli([command, link], { home: await tempDir() });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("stubs init");
    expect(result.stderr).toContain("Nothing was consumed");
    expect(server.sent).toEqual([]);
  });

  it.each(["pull", "check"])("%s exits 3 with the wrong identity and makes no request", async (command) => {
    const link = await server.seed(STUB, ORIGIN, (await generateIdentity()).publicId);
    const result = await cli([command, link, "--json"]);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      code: "invalid",
      message: "This stub isn't locked to this machine's identity (or the link was altered). Nothing was consumed.",
    });
    expect(server.sent).toEqual([]);
    expect(server.store.size).toBe(1);
  });

  it("exits 3 when the wrapped key was altered", async () => {
    const link = await server.seed(STUB, ORIGIN, publicId);
    const altered = link.slice(0, -1) + (link.endsWith("A") ? "B" : "A");
    expect((await cli(["pull", altered])).code).toBe(3);
    expect(server.sent).toEqual([]);
  });

  it("exits 1 naming the file when the identity is malformed", async () => {
    const link = await server.seed(STUB, ORIGIN, publicId);
    await writeFile(join(home, ".config/stubs/identity"), "# stubs identity v1\nnot-a-key\n");
    const result = await cli(["pull", link]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(join(home, ".config/stubs/identity"));
    expect(result.stderr).not.toContain("not-a-key");
    expect(server.sent).toEqual([]);
  });

  it("push --to locks to the recipient, who can then pull", async () => {
    const pushed = await cli(["push", "-", "--to", publicId], { home: await tempDir(), stdin: "A=1\n" });
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).toContain(`Locked to ${publicId}.`);
    const link = pushed.stdout.trim();
    expect(link).toMatch(/^https:\/\/stubs\.talix\.app\/t#v2\.[\w-]{43}\.[\w-]{80}$/);

    expect((await cli(["pull", link], { home: await tempDir() })).code).toBe(3);
    expect((await cli(["pull", link])).code).toBe(0);
    expect(await envFile()).toBe("A=1\n");
  });

  it("push --to --json adds locked: true", async () => {
    const result = await cli(["push", "-", "--to", publicId, "--json"], { stdin: "A=1" });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, locked: true });
    const plain = await cli(["push", "-", "--json"], { stdin: "A=1" });
    expect(JSON.parse(plain.stdout)).not.toHaveProperty("locked");
  });

  it.each(["stubs1short", "ssh-ed25519 AAAA", `${"stubs1"}${"!".repeat(43)}`, ""])(
    "push --to %j exits 3 and sends nothing",
    async (id) => {
      const result = await cli(["push", "-", "--to", id], { stdin: "A=1" });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("That isn't a stubs id. Nothing was sent.");
      expect(server.sent).toEqual([]);
    },
  );

  it("push --to a degenerate key exits 3 and sends nothing", async () => {
    const result = await cli(["push", "-", "--to", `stubs1${"A".repeat(43)}`, "--json"], { stdin: "A=1" });
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      code: "invalid",
      message: "That stubs id can't receive a locked stub. Ask the recipient to run `stubs id` again. Nothing was sent.",
    });
    expect(server.sent).toEqual([]);
  });

  it("init and id print the public id", async () => {
    const fresh = await tempDir();
    const init = await cli(["init"], { home: fresh });
    expect(init.code).toBe(0);
    const id = /Your stubs id: (\S+)\nShare it with whoever sends you locked stubs\.\n/.exec(init.stdout)?.[1];
    expect(id).toMatch(PUBLIC_ID_PATTERN);
    expect((await cli(["id"], { home: fresh })).stdout).toBe(`${id}\n`);
    expect(JSON.parse((await cli(["id", "--json"], { home: fresh })).stdout)).toEqual({ ok: true, publicId: id });

    const again = await cli(["init", "--json"], { home: fresh });
    expect(again.code).toBe(3);
    expect(JSON.parse(again.stdout)).toMatchObject({ ok: false, code: "invalid" });

    const forced = await cli(["init", "--force", "--json"], { home: fresh });
    expect(forced.code).toBe(0);
    const replaced = JSON.parse(forced.stdout);
    expect(replaced).toMatchObject({ ok: true, created: true });
    expect(replaced.publicId).not.toBe(id);
  });

  it("id exits 3 when there's no identity", async () => {
    const result = await cli(["id"], { home: await tempDir() });
    expect(result).toMatchObject({ code: 3, stderr: "stubs: No identity yet. Run `stubs init`.\n" });
  });

  it.each([["init", "x"], ["id", "--force"], ["init", "--origin", "x"]])("rejects %j with exit 3", async (...args) => {
    expect((await cli(args)).code).toBe(3);
  });
});

describe("links on stdin", () => {
  const withStdin = (args: string[], stdin: string) => runCli(args, { server, cwd, stdin });

  it("pull - reads the link from stdin and writes the file", async () => {
    const link = await server.seed(STUB, ORIGIN);
    const result = await withStdin(["pull", "-", "--json"], `${link}\n`);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, written: ["API_KEY", "DB_URL", "SECRET"] });
    expect(await envFile()).toContain("API_KEY=sk-123");
    expect(result.stdout + result.stderr).not.toContain(link.split("#")[1]);
  });

  it("check - reads the link from stdin without consuming", async () => {
    const link = await server.seed(STUB, ORIGIN);
    const result = await withStdin(["check", "-"], `  ${link}  `);
    expect(result).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Sealed\./) });
    expect(server.store.size).toBe(1);
  });

  it("exits 3 on empty stdin without a request", async () => {
    await server.seed(STUB, ORIGIN);
    const result = await withStdin(["pull", "-"], "\n");
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Nothing on stdin");
    expect(server.sent).toEqual([]);
  });
});

describe("pull holds back $ references", () => {
  it("keeps the value as a comment, warns on stderr, and still exits 0", async () => {
    await writeFile(join(cwd, ".env.local"), "PRIVATE_KEY=sk-live\n");
    const link = await server.seed("PUBLIC_X=$PRIVATE_KEY\nOK=1", ORIGIN);
    const result = await pull(link);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Pulled 1 value into .env.local: OK\nHeld back 1 value with a $ reference: PUBLIC_X\n");
    expect(result.stderr).toContain("PUBLIC_X looks like a $NAME reference");
    expect(result.stderr).not.toContain("sk-live");
    expect(await envFile()).toBe("PRIVATE_KEY=sk-live\nOK=1\n# stubs held back ($ reference): PUBLIC_X='$PRIVATE_KEY'\n");
  });

  it("reports held and the warning in JSON", async () => {
    const link = await server.seed("URL=https://$HOST/path", ORIGIN);
    const result = await pull(link, "--json");
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, written: [], held: ["URL"], warnings: [expect.stringContaining("URL looks like")] });
  });
});
