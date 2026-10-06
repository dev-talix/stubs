// Runs the built binary against a real HTTP fake server and checks that no value and no link
// fragment ever reaches stdout or stderr (R6), on success and on every post-claim failure.

import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/core/lock";
import { fakeServer, type FakeServer } from "./helpers/fake-server";
import { useTempDirs } from "./helpers/temp";

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "cli/dist/stubs.js");
const CANARY = "hunter2-9f3a";
const STUB = `CANARY_SECRET=${CANARY}\nOTHER=x-${CANARY}-y\nnot a pair ${CANARY}\n`;

const tempDir = useTempDirs();
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
    const child = spawn(process.execPath, [BIN, ...argv], { cwd, env });
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

describe("stubs mcp over stdio", () => {
  /** Sends JSON-RPC lines to `stubs mcp` and returns the raw stdout once `id` answers. */
  function mcpExchange(messages: object[], waitForId: number): Promise<string> {
    return new Promise((done, failed) => {
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdg };
      const child = spawn(process.execPath, [BIN, "mcp"], { cwd, env });
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
    for (const command of ["stubs pull", "stubs check", "stubs push", "stubs init", "stubs id", "stubs mcp"]) {
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

  it("exits 3 on an unknown flag", async () => {
    expect((await stubs(["pull", "--nope"])).code).toBe(3);
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
