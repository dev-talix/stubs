import { execFile, spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { parseTicketFragment, revealTicket } from "../../src/core/ticket";
import { fakeServer, type FakeServer } from "./helpers/fake-server";
import { useTempDirs } from "./helpers/temp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "cli/dist/stubs.js");
const DRIVER = join(ROOT, "cli/test/helpers/terminal.py");
const exec = promisify(execFile);
const tempDir = useTempDirs();
const hasPty = process.platform !== "win32" && await exec("python3", ["-c", "import termios"]).then(() => true, () => false);
let cwd: string;
let server: FakeServer;
let http: { origin: string; close: () => Promise<void> };

beforeAll(async () => {
  await exec(process.execPath, ["build.mjs"], { cwd: join(ROOT, "cli") });
});
beforeEach(async () => {
  cwd = await tempDir();
  server = fakeServer();
  http = await server.listen();
  return () => http.close();
});

type TerminalResult = { code: number; output: string; hidden: boolean; restored: boolean };
async function terminal(chunks: Buffer[], signal?: string): Promise<TerminalResult> {
  return new Promise((done, failed) => {
    const child = spawn("python3", [DRIVER], { cwd });
    const timeout = setTimeout(() => {
      child.kill();
      failed(new Error("PTY driver timed out"));
    }, 12_000);
    onTestFinished(() => { if (!child.killed) child.kill(); });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      failed(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return failed(new Error(`PTY driver failed: ${stderr}`));
      try { done(JSON.parse(stdout) as TerminalResult); } catch (error) { failed(error); }
    });
    child.stdin.end(JSON.stringify({
      argv: [process.execPath, BIN, "push", "--prompt", "--json", "--origin", http.origin],
      chunks: chunks.map((chunk) => chunk.toString("base64")), signal,
    }));
  });
}

describe.skipIf(!hasPty)("built hidden entry in a real terminal", () => {
  it("seals multiline paste without echo or plaintext files and restores the terminal", async () => {
    const result = await terminal([Buffer.from("\x1b[200~FIRST=synthetic-canary\r"), Buffer.from("\nSECOND=é-pty-canary\r\n\x1b[201~"), Buffer.from("\x04")]);
    expect(result.code).toBe(0);
    expect(result.hidden).toBe(true);
    expect(result.restored).toBe(true);
    expect(result.output).not.toContain("synthetic-canary");
    expect(result.output).not.toContain("pty-canary");
    expect(await readdir(cwd)).toEqual([]);
    expect(server.sent).toHaveLength(2);
    expect(server.sent.join("")).not.toContain("synthetic-canary");
    expect(result.output).toContain("\x1b[?2004h");
    expect(result.output).toContain("\x1b[?2004l");
    const line = result.output.split("\n").find((line) => line.startsWith("{\"ok\":true"));
    const { link } = JSON.parse(line!) as { link: string };
    const fragment = parseTicketFragment(link.split("#")[1]!);
    if (fragment.kind !== "ticket") throw new Error("Expected an unlocked test stub");
    const opened = await revealTicket(fragment.capability, server.transport);
    expect(opened).toMatchObject({ kind: "opened", plaintext: "FIRST=synthetic-canary\nSECOND=é-pty-canary\n" });
  });

  it.each(["\x03", "\x04"])("rejects pasted %j without issuing or echoing delayed trailing input", async (key) => {
    const result = await terminal([
      Buffer.from(`\x1b[200~A=synthetic${key}`),
      Buffer.from("TRAILING=private-paste-canary\x1b[201~"),
      Buffer.from("\x04"),
    ]);
    expect(result.code).toBe(3);
    expect(result.hidden).toBe(true);
    expect(result.restored).toBe(true);
    expect(result.output).not.toContain("synthetic");
    expect(result.output).not.toContain("private-paste-canary");
    expect(server.sent).toEqual([]);
    expect(await readdir(cwd)).toEqual([]);
  });

  it.each(["\x03", "\x04"])("drains rejected nested paste through the outer close before handling %j", async (key) => {
    const result = await terminal([
      Buffer.from(`\x1b[200~OUTER=first\x1b[200~INNER=second\x1b[201~${key}`),
      Buffer.from("TRAILING=nested-paste-canary\x1b[201~"),
      Buffer.from("\x04"),
    ]);
    expect(result.code).toBe(3);
    expect(result.hidden).toBe(true);
    expect(result.restored).toBe(true);
    expect(result.output).not.toContain("nested-paste-canary");
    expect(server.sent).toEqual([]);
  });

  it.each([
    ["\x1b[", "\x03"], ["\x1b[", "\x04"],
    ["\x1b\x1b", "\x03"], ["\x1b\x1b", "\x04"],
  ])("resynchronizes malformed prefix %j before nested paste containing %j", async (prefix, key) => {
    const result = await terminal([
      Buffer.from(`\x1b[200~A=synthetic${prefix}\x1b[200~INNER=hidden\x1b[201~${key}`),
      Buffer.from("TRAILING=private-resync-canary\x1b[201~"),
      Buffer.from("\x04"),
    ]);
    expect(result.code).toBe(3);
    expect(result.hidden).toBe(true);
    expect(result.restored).toBe(true);
    expect(result.output).not.toContain("private-resync-canary");
    expect(server.sent).toEqual([]);
  });

  it.each(["\x03", "\x04"])("restores on Ctrl-C or empty Ctrl-D %j without issuance", async (key) => {
    const result = await terminal([Buffer.from(key)]);
    expect(result.code).toBe(key === "\x03" ? 130 : 3);
    expect(result.hidden).toBe(true);
    expect(result.restored).toBe(true);
    expect(server.sent).toEqual([]);
    expect(await readdir(cwd)).toEqual([]);
  });

  it("keeps oversized paste and its trailing canary hidden until completion", async () => {
    const result = await terminal([Buffer.alloc(32 * 1024 + 1, 97), Buffer.from("TRAILING=oversize-canary\r\n\x04")]);
    expect(result.code).toBe(3);
    expect(result.hidden).toBe(true);
    expect(result.restored).toBe(true);
    expect(result.output).not.toContain("aaaa");
    expect(result.output).not.toContain("oversize-canary");
    expect(server.sent).toEqual([]);
  });

  it("restores on external SIGTERM without issuance", async () => {
    const result = await terminal([], "SIGTERM");
    expect(result.code).toBe(130);
    expect(result.hidden).toBe(true);
    expect(result.restored).toBe(true);
    expect(server.sent).toEqual([]);
  });
});

it("rejects non-TTY input promptly without consuming an open stdin pipe", async () => {
  const child = spawn(process.execPath, [BIN, "push", "--prompt", "--json", "--origin", http.origin], { cwd });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  try {
    const code = await new Promise((done, failed) => {
      child.on("close", done);
      child.on("error", failed);
    });
    expect(code).toBe(3);
    expect(JSON.parse(output)).toMatchObject({ ok: false, code: "invalid" });
    expect(server.sent).toEqual([]);
  } finally { child.kill(); }
}, 3000);
