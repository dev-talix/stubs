import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_ID_PATTERN, publicIdFromSecret } from "../../src/core/lock";
import { createIdentity, identityPath, loadIdentity } from "../src/identity";
import { isFailure } from "../src/result";
import { useTempDirs } from "./helpers/temp";

const tempDir = useTempDirs();
const modes = process.platform !== "win32";
const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe("identityPath", () => {
  it("honours an absolute XDG_CONFIG_HOME and ignores a relative one", () => {
    expect(identityPath({ env: { XDG_CONFIG_HOME: "/xdg" }, home: "/home/u" })).toBe("/xdg/stubs/identity");
    expect(identityPath({ env: { XDG_CONFIG_HOME: "rel" }, home: "/home/u" })).toBe("/home/u/.config/stubs/identity");
    expect(identityPath({ env: {}, home: "/home/u" })).toBe("/home/u/.config/stubs/identity");
  });
});

describe("createIdentity", () => {
  it("writes the v1 file with 0600 inside a 0700 directory", async () => {
    const home = await tempDir();
    const created = await createIdentity({ env: {}, home });
    if (isFailure(created)) throw new Error(created.message);
    expect(created.publicId).toMatch(PUBLIC_ID_PATTERN);

    const path = join(home, ".config/stubs/identity");
    const [header, secret, rest] = (await readFile(path, "utf8")).split("\n");
    expect(header).toBe("# stubs identity v1");
    expect(rest).toBe("");
    // Base64url PKCS#8 for X25519: 48 bytes, 64 characters.
    expect(secret).toMatch(/^[\w-]{64}$/);
    expect(await publicIdFromSecret(secret!)).toBe(created.publicId);
    if (modes) {
      expect(await mode(path)).toBe(0o600);
      expect(await mode(join(home, ".config/stubs"))).toBe(0o700);
    }
  });

  it("uses XDG_CONFIG_HOME", async () => {
    const xdg = await tempDir();
    await createIdentity({ env: { XDG_CONFIG_HOME: xdg }, home: "/nonexistent" });
    expect((await stat(join(xdg, "stubs/identity"))).isFile()).toBe(true);
  });

  it.skipIf(!modes)("tightens an existing stubs directory to 0700", async () => {
    const home = await tempDir();
    await mkdir(join(home, ".config/stubs"), { recursive: true, mode: 0o755 });
    await chmod(join(home, ".config/stubs"), 0o755);
    await createIdentity({ env: {}, home });
    expect(await mode(join(home, ".config/stubs"))).toBe(0o700);
  });

  it("refuses to replace an identity unless forced", async () => {
    const home = await tempDir();
    const path = join(home, ".config/stubs/identity");
    const first = await createIdentity({ env: {}, home });
    const before = await readFile(path, "utf8");

    const refused = await createIdentity({ env: {}, home });
    expect(refused).toMatchObject({ ok: false, code: "invalid" });
    expect(await readFile(path, "utf8")).toBe(before);

    const forced = await createIdentity({ env: {}, home }, { force: true });
    expect(forced).toMatchObject({ ok: true, created: true });
    expect((forced as { publicId: string }).publicId).not.toBe((first as { publicId: string }).publicId);
    if (modes) expect(await mode(path)).toBe(0o600);
  });
});

describe("loadIdentity", () => {
  it("returns null when there's no identity", async () => {
    expect(await loadIdentity({ env: {}, home: await tempDir() })).toBeNull();
  });

  it("loads what createIdentity wrote", async () => {
    const home = await tempDir();
    const created = await createIdentity({ env: {}, home });
    const loaded = await loadIdentity({ env: {}, home });
    expect(loaded).toMatchObject({ publicId: (created as { publicId: string }).publicId });
  });

  it.each([
    ["a wrong header", "# something else\nHEADERLESS-CONTENT\n"],
    ["a bad key", "# stubs identity v1\nnot-a-key-SECRETISH\n"],
    ["an empty file", ""],
    ["a raw 32-byte key instead of PKCS#8", `# stubs identity v1\n${"Q".repeat(43)}\n`],
  ])("fails on %s, naming the path but not the contents", async (_, content) => {
    const home = await tempDir();
    const path = join(home, ".config/stubs/identity");
    await mkdir(join(home, ".config/stubs"), { recursive: true });
    await writeFile(path, content);
    const loaded = await loadIdentity({ env: {}, home });
    expect(loaded).toMatchObject({ ok: false, code: "error" });
    const message = (loaded as { message: string }).message;
    expect(message).toContain(path);
    expect(message).not.toContain("SECRETISH");
    expect(message).not.toContain("HEADERLESS-CONTENT");
  });

  it.skipIf(!modes || process.getuid?.() === 0)("fails on an unreadable file", async () => {
    const home = await tempDir();
    await createIdentity({ env: {}, home });
    const path = join(home, ".config/stubs/identity");
    await chmod(path, 0o000);
    try {
      expect(await loadIdentity({ env: {}, home })).toMatchObject({ ok: false, code: "error" });
    } finally {
      await chmod(path, 0o600);
    }
  });
});
