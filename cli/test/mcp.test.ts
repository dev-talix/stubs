import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/core/lock";
import { createIdentity } from "../src/identity";
import { createMcpServer } from "../src/mcp";
import { checkProjectBoundary } from "../src/pull";
import { readPackageVersion } from "../src/version";
import { fakeServer, type FakeServer } from "./helpers/fake-server";
import { ORIGIN } from "./helpers/run";
import { useTempDirs } from "./helpers/temp";

const tempDir = useTempDirs();
const CANARY = "hunter2-9f3a";

let server: FakeServer;
let cwd: string;
let home: string;
let client: Client;
beforeEach(async () => {
  server = fakeServer();
  cwd = await tempDir();
  home = await tempDir();
  await connect(cwd);
});

async function connect(directory: string) {
  const mcp = createMcpServer({ cwd: directory, env: {}, home, makeTransport: () => server.transport });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  expect(content).toHaveLength(1);
  return { isError: result.isError === true, body: JSON.parse(content[0]!.text), raw: content[0]!.text };
}

describe("mcp server", () => {
  it.each([
    ["posix", posix, "/"],
    ["win32", win32, "C:\\"],
  ] as const)("checks canonical project boundaries with exact case on %s", (_name, path, root) => {
    const project = path.join(root, "x", "project");
    const rejected = {
      ok: false,
      code: "invalid",
      message: "The env file must stay inside the project directory, including symlink targets. Nothing was consumed.",
    };
    expect(checkProjectBoundary(path.join(root, "x", "PROJECT", "private.env"), project, path.sep)).toEqual(rejected);
    expect(checkProjectBoundary(path.join(root, "x", "project-other", "private.env"), project, path.sep)).toEqual(rejected);
    expect(checkProjectBoundary(project, project, path.sep)).toEqual(rejected);
    expect(checkProjectBoundary(root, root, path.sep)).toEqual(rejected);
    expect(checkProjectBoundary(path.join(project, ".env"), project, path.sep)).toBeNull();
    expect(checkProjectBoundary(path.join(root, ".env"), root, path.sep)).toBeNull();
  });

  it("lists only pull_stub and check_stub", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["check_stub", "pull_stub"]);
    const pull = tools.find((tool) => tool.name === "pull_stub")!;
    expect(pull.description).toBe(
      `Open a one-time Stubs link and write its values into the project's env file. Returns key names only. Never read or print the env file afterwards; run commands that need the values with \`npx -y --loglevel=warn -- @talix/stubs@${readPackageVersion()} run -- <cmd>\`, which masks them in the output.`,
    );
    expect(Object.keys(pull.inputSchema.properties ?? {}).sort()).toEqual(["file", "link", "overwrite"]);
  });

  it("pulls into the working directory and returns key names only", async () => {
    const link = await server.seed(`CANARY_SECRET=${CANARY}\nPORT=1`, ORIGIN);
    const result = await call("pull_stub", { link });
    expect(result).toMatchObject({
      isError: false,
      body: { ok: true, file: ".env.local", written: ["CANARY_SECRET", "PORT"], skipped: [], unparsed: 0 },
    });
    expect(result.raw).not.toContain(CANARY);
    expect(await readFile(join(cwd, ".env.local"), "utf8")).toContain(CANARY);
  });

  it("honours file and overwrite", async () => {
    const link = await server.seed("A=1", ORIGIN);
    expect((await call("pull_stub", { link, file: "x.env", overwrite: true })).body.file).toBe("x.env");
  });

  it("returns failures as isError results, never throwing", async () => {
    const link = await server.seed(`CANARY_SECRET=${CANARY}`, ORIGIN);
    server.tamperAll();
    const tampered = await call("pull_stub", { link });
    expect(tampered).toMatchObject({ isError: true, body: { ok: false, code: "tampered" } });
    expect(tampered.raw).not.toContain(link.split("#")[1]);

    const wrongOrigin = await call("pull_stub", { link: link.replace("stubs.talix.app", "evil.example") });
    expect(wrongOrigin).toMatchObject({ isError: true, body: { code: "invalid" } });

    server.transport = () => {
      throw new Error("boom");
    };
    const thrown = await call("check_stub", { link });
    expect(thrown.isError).toBe(true);
  });

  it("pulls a stub locked to this machine's identity", async () => {
    const { publicId } = (await createIdentity({ env: {}, home })) as { publicId: string };
    const link = await server.seed(`CANARY_SECRET=${CANARY}`, ORIGIN, publicId);
    expect((await call("check_stub", { link })).body).toMatchObject({ status: "sealed" });
    const result = await call("pull_stub", { link });
    expect(result).toMatchObject({ isError: false, body: { written: ["CANARY_SECRET"] } });
    expect(result.raw).not.toContain(CANARY);
  });

  it("refuses a stub locked to someone else without a network call", async () => {
    await createIdentity({ env: {}, home });
    const link = await server.seed("A=1", ORIGIN, (await generateIdentity()).publicId);
    expect(await call("pull_stub", { link })).toMatchObject({ isError: true, body: { code: "invalid" } });
    expect(server.sent).toEqual([]);
  });

  it.each([
    ["pull_stub", {}],
    ["pull_stub", { link: 42 }],
    ["pull_stub", { link: "  " }],
    ["pull_stub", { link: "https://stubs.talix.app/t#v1.x", file: 7 }],
    ["pull_stub", { link: "https://stubs.talix.app/t#v1.x", overwrite: "yes" }],
    ["check_stub", { link: null }],
    ["check_stub", {}],
  ])("%s answers bad input %j in our envelope", async (name, args) => {
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(result.body).toMatchObject({ ok: false, code: "invalid" });
    expect(typeof result.body.message).toBe("string");
    expect(server.sent).toEqual([]);
  });

  it.each(["/tmp/leak.env", "../leak.env", "sub/../../leak.env", "..", "."])(
    "refuses to write %s outside the project without a network call",
    async (file) => {
      const link = await server.seed(`CANARY_SECRET=${CANARY}`, ORIGIN);
      const result = await call("pull_stub", { link, file });
      expect(result).toMatchObject({ isError: true, body: { ok: false, code: "invalid" } });
      expect(result.body.message).toContain("inside the project");
      expect(server.sent).toEqual([]);
      expect(server.store.size).toBe(1);
    },
  );

  it("still writes to a nested path inside the project", async () => {
    const link = await server.seed("A=1", ORIGIN);
    await mkdir(join(cwd, "apps", "web"), { recursive: true });
    expect((await call("pull_stub", { link, file: "apps/web/.env.local" })).body).toMatchObject({ ok: true });
    expect(await readFile(join(cwd, "apps", "web", ".env.local"), "utf8")).toBe("A=1\n");
  });

  it.each([undefined, "custom.env"])("rejects an outside file symlink for file=%s before consuming", async (file) => {
    const outside = await tempDir();
    const target = join(outside, "private.env");
    await writeFile(target, "PRIVATE=unchanged\n");
    await symlink(target, join(cwd, file ?? ".env.local"));
    const link = await server.seed("A=1", ORIGIN);
    expect(await call("pull_stub", { link, file })).toMatchObject({ isError: true, body: { code: "invalid" } });
    expect(server.sent).toEqual([]);
    expect(server.store.size).toBe(1);
    expect(await readFile(target, "utf8")).toBe("PRIVATE=unchanged\n");
    expect(await readdir(outside)).toEqual(["private.env"]);
    expect((await lstat(join(cwd, file ?? ".env.local"))).isSymbolicLink()).toBe(true);
  });

  it("rejects a symlinked outside parent for a new file before consuming", async () => {
    const outside = await tempDir();
    await symlink(outside, join(cwd, "config"));
    const link = await server.seed("A=1", ORIGIN);
    expect(await call("pull_stub", { link, file: "config/new.env" })).toMatchObject({
      isError: true, body: { code: "invalid" },
    });
    expect(server.sent).toEqual([]);
    expect(server.store.size).toBe(1);
    expect(await readdir(outside)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("rejects an unreadable outside file as invalid before consuming", async () => {
    const target = join(await tempDir(), "private.env");
    await writeFile(target, "PRIVATE=unchanged\n");
    await symlink(target, join(cwd, ".env.local"));
    await chmod(target, 0o000);
    try {
      const link = await server.seed("A=1", ORIGIN);
      expect(await call("pull_stub", { link })).toMatchObject({ isError: true, body: { code: "invalid" } });
      expect(server.sent).toEqual([]);
      expect(server.store.size).toBe(1);
    } finally {
      await chmod(target, 0o600);
    }
    expect(await readFile(target, "utf8")).toBe("PRIVATE=unchanged\n");
  });

  it.skipIf(process.getuid?.() === 0)("rejects an unwritable outside parent as invalid before consuming", async () => {
    const outside = await tempDir();
    await symlink(outside, join(cwd, "config"));
    await chmod(outside, 0o500);
    try {
      const link = await server.seed("A=1", ORIGIN);
      expect(await call("pull_stub", { link, file: "config/new.env" })).toMatchObject({
        isError: true, body: { code: "invalid" },
      });
      expect(server.sent).toEqual([]);
      expect(server.store.size).toBe(1);
    } finally {
      await chmod(outside, 0o700);
    }
    expect(await readdir(outside)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0).each([false, true])(
    "rejects a non-searchable outside parent as invalid, new file=%s",
    async (newFile) => {
      const outside = await tempDir();
      const target = join(outside, "private.env");
      await writeFile(target, "PRIVATE=unchanged\n");
      await symlink(outside, join(cwd, "config"));
      await chmod(outside, 0o000);
      try {
        const link = await server.seed("A=1", ORIGIN);
        expect(await call("pull_stub", { link, file: `config/${newFile ? "new.env" : "private.env"}` })).toMatchObject({
          isError: true,
          body: { code: "invalid", message: "The env file or its folder can't be accessed. Nothing was consumed." },
        });
        expect(server.sent).toEqual([]);
        expect(server.store.size).toBe(1);
      } finally {
        await chmod(outside, 0o700);
      }
      expect(await readFile(target, "utf8")).toBe("PRIVATE=unchanged\n");
      expect(await readdir(outside)).toEqual(["private.env"]);
    },
  );

  it("rejects a sibling directory sharing the project's path prefix", async () => {
    const parent = await tempDir();
    const project = join(parent, "project");
    const sibling = join(parent, "project-other");
    await mkdir(project);
    await mkdir(sibling);
    await symlink(sibling, join(project, "config"));
    await client.close();
    await connect(project);
    const link = await server.seed("A=1", ORIGIN);
    expect(await call("pull_stub", { link, file: "config/new.env" })).toMatchObject({
      isError: true, body: { code: "invalid" },
    });
    expect(server.sent).toEqual([]);
    expect(server.store.size).toBe(1);
    expect(await readdir(sibling)).toEqual([]);
  });

  it("rejects a dangling file symlink without replacing it or consuming", async () => {
    const outside = await tempDir();
    const target = join(outside, "missing.env");
    await symlink(target, join(cwd, ".env.local"));
    const link = await server.seed("A=1", ORIGIN);
    expect(await call("pull_stub", { link })).toMatchObject({ isError: true, body: { code: "invalid" } });
    expect(server.sent).toEqual([]);
    expect(server.store.size).toBe(1);
    expect(await readlink(join(cwd, ".env.local"))).toBe(target);
    expect(await readdir(outside)).toEqual([]);
  });

  it.each([false, true])("writes through an inside-project symlink, new file=%s", async (newFile) => {
    await mkdir(join(cwd, "shared"));
    const target = join(cwd, "shared", "real.env");
    if (newFile) await symlink("shared", join(cwd, "config"));
    else {
      await writeFile(target, "X=1\n");
      await symlink("shared/real.env", join(cwd, ".env.local"));
    }
    const link = await server.seed("A=1", ORIGIN);
    expect(await call("pull_stub", { link, file: newFile ? "config/real.env" : undefined })).toMatchObject({
      isError: false, body: { ok: true },
    });
    expect(await readFile(target, "utf8")).toBe(newFile ? "A=1\n" : "X=1\nA=1\n");
    expect((await lstat(join(cwd, newFile ? "config" : ".env.local"))).isSymbolicLink()).toBe(true);
  });

  it("uses the real project root when the working directory is a symlink", async () => {
    const alias = join(await tempDir(), "project");
    await symlink(cwd, alias);
    await client.close();
    await connect(alias);
    const link = await server.seed("A=1", ORIGIN);
    expect(await call("pull_stub", { link })).toMatchObject({ isError: false, body: { ok: true } });
    expect(await readFile(join(cwd, ".env.local"), "utf8")).toBe("A=1\n");
  });

  it("writes the checked canonical target if the original file symlink changes during claim", async () => {
    const outside = join(await tempDir(), "private.env");
    await writeFile(outside, "PRIVATE=unchanged\n");
    const target = join(cwd, "real.env");
    await writeFile(target, "X=1\n");
    const alias = join(cwd, ".env.local");
    await symlink(target, alias);
    server.onClaim = async () => {
      await rm(alias);
      await symlink(outside, alias);
    };
    const link = await server.seed("A=1", ORIGIN);
    expect(await call("pull_stub", { link })).toMatchObject({ isError: false, body: { ok: true } });
    expect(await readFile(target, "utf8")).toBe("X=1\nA=1\n");
    expect(await readFile(outside, "utf8")).toBe("PRIVATE=unchanged\n");
  });

  it("ignores extra arguments", async () => {
    const link = await server.seed("A=1", ORIGIN);
    expect((await call("pull_stub", { link, extra: true })).body).toMatchObject({ ok: true });
  });

  it("still lists argument names and descriptions", async () => {
    const { tools } = await client.listTools();
    const pull = tools.find((tool) => tool.name === "pull_stub")!;
    expect(pull.inputSchema.properties?.link).toMatchObject({ description: expect.stringContaining("link") });
  });

  it("redacts a link echoed back through a file path", async () => {
    const link = await server.seed(`CANARY_SECRET=${CANARY}`, ORIGIN);
    const result = await call("pull_stub", { link, file: link });
    expect(result).toMatchObject({ isError: true, body: { code: "invalid" } });
    expect(result.raw).not.toContain(link.split("#")[1]!.slice(3, 23));
  });

  it("checks without consuming", async () => {
    const link = await server.seed("A=1", ORIGIN);
    expect((await call("check_stub", { link })).body).toMatchObject({ ok: true, status: "sealed" });
    expect(server.store.size).toBe(1);
  });

  it("names the MCP server on every request", async () => {
    const link = await server.seed("A=1", ORIGIN);
    expect((await call("check_stub", { link })).isError).toBe(false);
    expect((await call("pull_stub", { link })).isError).toBe(false);
    expect(server.clients.length).toBeGreaterThanOrEqual(2);
    expect(server.clients.every((client) => client === "mcp")).toBe(true);
  });
});
