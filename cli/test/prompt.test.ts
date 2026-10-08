import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { describe, expect, it } from "vitest";
import { MAX_PLAINTEXT_BYTES } from "../../src/shared/protocol";
import { readHiddenInput } from "../src/prompt";

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) { this.isRaw = raw; return this; },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  input.pause();
  let shown = "";
  output.on("data", (chunk: Buffer) => { shown += chunk.toString(); });
  const read = () => readHiddenInput(input as unknown as ReadStream, output as unknown as WriteStream);
  return { input, output, read, shown: () => shown };
}

describe("hidden terminal input lifecycle", () => {
  it("normalizes split CRLF, preserves UTF-8 and restores before resolving", async () => {
    const tty = terminal();
    const reading = tty.read();
    expect(tty.input.isRaw).toBe(true);
    const utf8 = Buffer.from("SECOND=canary-é\r");
    tty.input.write("FIRST=synthetic\r");
    tty.input.write("\n");
    tty.input.write(utf8.subarray(0, utf8.length - 2));
    tty.input.write(utf8.subarray(utf8.length - 2));
    tty.input.write("\n\x04");
    expect(await reading).toBe("FIRST=synthetic\nSECOND=canary-é\n");
    expect(tty.input.isRaw).toBe(false);
    expect(tty.input.isPaused()).toBe(true);
    expect(tty.shown()).not.toContain("synthetic");
    expect(tty.shown()).not.toContain("canary");
    expect(tty.input.listenerCount("data")).toBe(0);
  });

  it("handles Unicode backspace and line clearing outside a paste", async () => {
    const tty = terminal();
    const reading = tty.read();
    tty.input.write("A=é\x7fx\rB=wrong\x15B=right\x04");
    expect(await reading).toBe("A=x\nB=right");
  });

  it("enables bracketed paste and accepts multiline paste with split wrappers", async () => {
    const tty = terminal();
    const reading = tty.read();
    tty.input.write("\x1b[20");
    tty.input.write("0~A=first\r\nB=second\x1b[2");
    tty.input.write("01~");
    expect(tty.input.isRaw).toBe(true);
    tty.input.write("\x04");
    expect(await reading).toBe("A=first\nB=second");
    expect(tty.shown()).toContain("\x1b[?2004h");
    expect(tty.shown()).toContain("\x1b[?2004l");
    expect(tty.input.isRaw).toBe(false);
  });

  it.each(["\x03", "\x04", "\x7f", "\x15"])("rejects pasted control %j and drains through split closing wrapper", async (key) => {
    const tty = terminal();
    const reading = tty.read();
    tty.input.write(`\x1b[200~A=synthetic${key}`);
    expect(tty.input.isRaw).toBe(true);
    tty.input.write("TRAILING=private-paste-canary\x1b[20");
    expect(tty.input.isRaw).toBe(true);
    tty.input.write("1~");
    expect(tty.input.isRaw).toBe(true);
    tty.input.write("\x04");
    expect(await reading).toMatchObject({ ok: false, code: "invalid" });
    expect(tty.input.isRaw).toBe(false);
    expect(tty.shown()).not.toContain("private-paste-canary");
  });

  it("drains oversized bracketed paste before accepting an explicit cancellation", async () => {
    const tty = terminal();
    const reading = tty.read();
    tty.input.write("\x1b[200~");
    tty.input.write(Buffer.alloc(MAX_PLAINTEXT_BYTES + 1, 97));
    tty.input.write("\x04\x03\x1b[201~");
    expect(tty.input.isRaw).toBe(true);
    tty.input.write("\x03");
    expect(await reading).toMatchObject({ ok: false, exitCode: 130 });
    expect(tty.input.isRaw).toBe(false);
  });

  it.each(["\x03", "\x04"])("drains nested rejected paste through the outer split close before handling %j", async (key) => {
    const tty = terminal();
    const reading = tty.read();
    tty.input.write("\x1b[200~OUTER=first\x1b[20");
    tty.input.write(`0~INNER=second\x1b[201~${key}`);
    expect(tty.input.isRaw).toBe(true);
    tty.input.write("TRAILING=nested-paste-canary\x1b[20");
    expect(tty.input.isRaw).toBe(true);
    tty.input.write("1~");
    expect(tty.input.isRaw).toBe(true);
    tty.input.write("\x04");
    expect(await reading).toMatchObject({ ok: false, code: "invalid" });
    expect(tty.input.isRaw).toBe(false);
    expect(tty.shown()).not.toContain("nested-paste-canary");
  });

  it.each([
    ["\x1b[", "\x03"], ["\x1b[", "\x04"],
    ["\x1b\x1b", "\x03"], ["\x1b\x1b", "\x04"],
  ])("resynchronizes prefix %j before a nested opener and pasted %j", async (prefix, key) => {
    const tty = terminal();
    let resolved = false;
    const reading = tty.read().then((result) => { resolved = true; return result; });
    tty.input.write(`\x1b[200~A=synthetic${prefix}\x1b[200~INNER=hidden\x1b[201~${key}`);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(tty.input.isRaw).toBe(true);
    tty.input.write("TRAILING=private-resync-canary\x1b[201~");
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(tty.input.isRaw).toBe(true);
    tty.input.write("\x04");
    expect(await reading).toMatchObject({ ok: false, code: "invalid" });
    expect(tty.input.isRaw).toBe(false);
    expect(tty.shown()).not.toContain("private-resync-canary");
  });

  it.each(["\x03", "\x00", "\x1b[A"])("restores on cancellation or unsupported input %j", async (key) => {
    const tty = terminal();
    const reading = tty.read();
    tty.input.write(`SECRET=synthetic-canary${key}\x04`);
    expect(await reading).toMatchObject({ ok: false });
    expect(tty.input.isRaw).toBe(false);
    expect(tty.shown()).not.toContain("synthetic-canary");
  });

  it.each(["error", "end", "close"])("restores on input %s without repeating error content", async (event) => {
    const tty = terminal();
    const reading = tty.read();
    tty.input.emit(event, new Error("synthetic-canary"));
    expect(await reading).toMatchObject({ ok: false });
    expect(tty.input.isRaw).toBe(false);
    expect(tty.shown()).not.toContain("synthetic-canary");
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP"] as const)("restores on %s and removes its signal handlers", async (signal) => {
    const tty = terminal();
    const before = process.listenerCount(signal);
    const reading = tty.read();
    process.emit(signal);
    expect(await reading).toMatchObject({ ok: false, exitCode: 130 });
    expect(tty.input.isRaw).toBe(false);
    expect(process.listenerCount(signal)).toBe(before);
  });

  it("accepts the exact byte limit and rejects one byte more", async () => {
    for (const extra of [0, 1]) {
      const tty = terminal();
      const reading = tty.read();
      tty.input.write(Buffer.alloc(MAX_PLAINTEXT_BYTES + extra, 97));
      tty.input.write("\x04");
      const result = await reading;
      if (extra === 0) expect(typeof result === "string" && Buffer.byteLength(result)).toBe(MAX_PLAINTEXT_BYTES);
      else expect(result).toMatchObject({ ok: false, code: "invalid" });
      expect(tty.input.isRaw).toBe(false);
    }
  });

  it("refuses redirected stdin or stderr without resuming input", async () => {
    for (const stream of ["input", "output"] as const) {
      const tty = terminal();
      tty[stream].isTTY = false;
      expect(await tty.read()).toMatchObject({ ok: false, code: "invalid" });
      expect(tty.input.isRaw).toBe(false);
      expect(tty.input.isPaused()).toBe(true);
      expect(tty.shown()).toBe("");
    }
  });

  it("restores after a synchronous prompt write fails", async () => {
    const tty = terminal();
    tty.output.write = () => { throw new Error("synthetic-canary"); };
    expect(await tty.read()).toMatchObject({ ok: false, code: "error" });
    expect(tty.input.isRaw).toBe(false);
  });
});
