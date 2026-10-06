// Ticket creation as an explicit state machine, so the view only renders states. One print can
// be in flight at a time, and what gets printed is the text as it was when submitted.

import { pairsOf, parseDotenv, type EnvLine } from "../core/dotenv";
import { PUBLIC_ID_PATTERN } from "../core/lock";
import type { IssueOutcome } from "../core/ticket";
import { MAX_PLAINTEXT_BYTES, type TtlSeconds } from "../shared/protocol";

export interface Draft {
  lines: EnvLine[];
  pairCount: number;
  bytes: number;
  overLimit: boolean;
  printable: boolean;
}

export function assessDraft(text: string): Draft {
  const lines = parseDotenv(text);
  const bytes = new TextEncoder().encode(text).length;
  const overLimit = bytes > MAX_PLAINTEXT_BYTES;
  return {
    lines,
    pairCount: pairsOf(lines).length,
    bytes,
    overLimit,
    printable: text.trim() !== "" && !overLimit,
  };
}

export type FailureReason = Extract<IssueOutcome, { kind: "failed" }>["reason"];

export type CreateState =
  | { kind: "editing" }
  | { kind: "printing" }
  | { kind: "failed"; reason: FailureReason }
  | { kind: "printed"; link: string; expiresAt: number; pairCount: number; locked: boolean };

/** `lockTo` is a recipient's public id, or empty for an ordinary stub. */
export type Issue = (text: string, ttlSeconds: TtlSeconds, lockTo: string) => Promise<IssueOutcome>;

/** Empty is fine (not locked); anything else must be a full public id. */
export function isAcceptableRecipient(lockTo: string): boolean {
  return lockTo === "" || PUBLIC_ID_PATTERN.test(lockTo);
}

export class CreateFlow {
  #state: CreateState = { kind: "editing" };

  constructor(
    private readonly issue: Issue,
    private readonly onChange: (state: CreateState) => void,
  ) {}

  get state(): CreateState {
    return this.#state;
  }

  /** Whether a submit right now would print, given the current text and recipient. */
  canSubmit(text: string, lockTo = ""): boolean {
    return this.#accepting() && assessDraft(text).printable && isAcceptableRecipient(lockTo);
  }

  async submit(text: string, ttlSeconds: TtlSeconds, lockTo = ""): Promise<void> {
    if (!this.canSubmit(text, lockTo)) return;
    const { pairCount } = assessDraft(text);
    this.#set({ kind: "printing" });
    // Never strand the flow in "printing": an unexpected throw becomes an ordinary failure.
    const outcome = await this.issue(text, ttlSeconds, lockTo).catch(
      (): IssueOutcome => ({ kind: "failed", reason: "server" }),
    );
    this.#set(
      outcome.kind === "issued"
        ? { kind: "printed", link: outcome.link, expiresAt: outcome.expiresAt, pairCount, locked: lockTo !== "" }
        : { kind: "failed", reason: outcome.reason },
    );
  }

  /** The text changed. A failure message no longer applies once the user edits. */
  edited(): void {
    if (this.#state.kind === "failed") this.#set({ kind: "editing" });
  }

  /** Start over after a ticket was printed. */
  reset(): void {
    if (this.#state.kind === "printed") this.#set({ kind: "editing" });
  }

  #accepting(): boolean {
    return this.#state.kind === "editing" || this.#state.kind === "failed";
  }

  #set(state: CreateState) {
    this.#state = state;
    this.onChange(state);
  }
}
