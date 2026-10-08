// Outcomes every command reports, and how each maps to an exit code (R5). Messages never contain
// a value or the link: errors say "the link", and only key names and file paths are named.

export type FailureCode =
  | "void"
  | "invalid"
  | "network"
  | "refused"
  | "tampered"
  | "uncertain"
  | "error";

export interface Failure {
  ok: false;
  code: FailureCode;
  message: string;
  /** Where pulled values were saved when the target couldn't be written. */
  recoveredFile?: string;
  /** For `run`, which follows env(1) rather than the table below: 126 or 127. */
  exitCode?: number;
}

const EXIT_CODES: Record<FailureCode, number> = {
  void: 2,
  invalid: 3,
  network: 4,
  refused: 5,
  tampered: 6,
  uncertain: 7,
  error: 1,
};

export function exitCodeFor(result: { ok: true } | Failure): number {
  return result.ok ? 0 : EXIT_CODES[result.code];
}

export function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

export function fail(code: FailureCode, message: string, extra: Partial<Failure> = {}): Failure {
  return { ok: false, code, message, ...extra };
}

/** A filesystem error's code (EACCES, ENOENT...), never its message. */
export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "unknown error";
}
