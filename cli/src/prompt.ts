import type { ReadStream, WriteStream } from "node:tty";
import { MAX_PLAINTEXT_BYTES } from "../../src/shared/protocol";
import { fail, type Failure } from "./result";

/** Owns terminal mode and input lifetime; never writes any of the input to the terminal. */
export function readHiddenInput(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stderr,
): Promise<string | Failure> {
  if (!input.isTTY || !output.isTTY) {
    return Promise.resolve(fail("invalid", "--prompt needs a terminal on stdin and stderr. Run it in your own terminal."));
  }

  return new Promise((resolve) => {
    const bytes = Buffer.alloc(MAX_PLAINTEXT_BYTES);
    const wasRaw = input.isRaw;
    let length = 0;
    let afterCr = false;
    let escape = "";
    let pasteDepth = 0;
    let bracketedPasteEnabled = false;
    let finished = false;
    let rejected: Failure | undefined;

    const cleanup = () => {
      input.pause();
      input.removeListener("data", data);
      input.removeListener("error", failed);
      input.removeListener("end", ended);
      input.removeListener("close", ended);
      for (const signal of signals) process.removeListener(signal, cancelled);
      process.removeListener("exit", exiting);
      try {
        if (bracketedPasteEnabled) output.write("\x1b[?2004l");
      } finally {
        input.setRawMode(wasRaw);
      }
    };
    const finish = (result: string | Failure) => {
      if (finished) return;
      finished = true;
      try {
        cleanup();
        output.write("\n");
      } catch {
        result = fail("error", "Couldn't restore the terminal. No stub was created.");
      }
      bytes.fill(0);
      resolve(result);
    };
    const cancelled = () => finish(fail("invalid", "Cancelled. No stub was created.", { exitCode: 130 }));
    const failed = () => finish(fail("error", "Couldn't read hidden input. No stub was created."));
    const ended = () => finish(fail("invalid", "Terminal input closed before Ctrl-D. No stub was created."));
    const exiting = () => {
      try { cleanup(); } catch { /* The process is already exiting. */ }
      bytes.fill(0);
    };
    const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP"] as const;
    const discard = (message: string) => {
      if (rejected) return;
      rejected = fail("invalid", message);
      bytes.fill(0);
      length = 0;
      output.write("Input discarded. After the paste ends, Ctrl-D finishes; Ctrl-C cancels.\n");
    };
    const data = (chunk: Buffer) => {
      try {
        for (const byte of chunk) {
          if (pasteDepth > 0 && (byte === 3 || byte === 4)) {
            discard("Pasted control characters aren't supported. No stub was created.");
            escape = "";
            continue;
          }
          if (byte === 3) return cancelled();
          if (byte === 4) {
            if (rejected) return finish(rejected);
            if (escape !== "") return failed();
            try {
              return finish(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
            } catch { return failed(); }
          }
          if (escape !== "" || byte === 27) {
            escape += String.fromCharCode(byte);
            if (escape === "\x1b[200~") {
              if (pasteDepth > 0) discard("Nested paste markers aren't supported. No stub was created.");
              pasteDepth++;
              escape = "";
            } else if (escape === "\x1b[201~") {
              if (pasteDepth === 0) discard("Unexpected paste marker. No stub was created.");
              else pasteDepth--;
              escape = "";
            } else if (!["\x1b[200~", "\x1b[201~"].some((marker) => marker.startsWith(escape))) {
              escape = byte === 27 ? "\x1b" : "";
              discard("Unsupported terminal key. Use plain text, Enter and Backspace. No stub was created.");
            }
            continue;
          }
          if (rejected) continue;
          if (pasteDepth > 0 && (byte === 127 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))) {
            discard("Pasted control characters aren't supported. No stub was created.");
            continue;
          }
          if (byte === 127 || byte === 8) {
            if (length > 0) {
              do { length--; } while (length > 0 && (bytes[length]! & 0xc0) === 0x80);
            }
            afterCr = false;
            continue;
          }
          if (byte === 21) {
            while (length > 0 && bytes[length - 1] !== 10) length--;
            afterCr = false;
            continue;
          }
          if (byte === 10 && afterCr) { afterCr = false; continue; }
          afterCr = byte === 13;
          if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
            discard("Unsupported control character. No stub was created.");
            continue;
          }
          if (length === MAX_PLAINTEXT_BYTES) {
            discard("Hidden input is larger than the 32 KB a stub can hold. No stub was created.");
            continue;
          }
          bytes[length++] = byte === 13 ? 10 : byte;
        }
      } catch { failed(); }
    };

    try {
      input.setRawMode(true);
      input.on("data", data);
      input.on("error", failed);
      input.on("end", ended);
      input.on("close", ended);
      for (const signal of signals) process.on(signal, cancelled);
      process.on("exit", exiting);
      bracketedPasteEnabled = true;
      output.write("\x1b[?2004h");
      output.write("Input is hidden. Enter or paste your .env. Ctrl-D finishes; Ctrl-C cancels.\n");
      input.resume();
    } catch { failed(); }
  });
}
