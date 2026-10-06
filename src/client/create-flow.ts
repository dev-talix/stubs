// Ticket creation as an explicit state machine, so the view only renders states. One print can
// be in flight at a time, and what gets printed is the text as it was when submitted.

import { pairsOf, parseDotenv, type EnvLine } from "./dotenv";
import type { IssueOutcome } from "./ticket";
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
  | { kind: "printed"; link: string; expiresAt: number; pairCount: number };

export type Issue = (text: string, ttlSeconds: TtlSeconds) => Promise<IssueOutcome>;

export class CreateFlow {
  #state: CreateState = { kind: "editing" };

  constructor(
    private readonly issue: Issue,
    private readonly onChange: (state: CreateState) => void,
  ) {}

  get state(): CreateState {
    return this.#state;
  }

  /** Whether a submit right now would print, given the current text. */
  canSubmit(text: string): boolean {
    return this.#accepting() && assessDraft(text).printable;
  }

  async submit(text: string, ttlSeconds: TtlSeconds): Promise<void> {
    if (!this.canSubmit(text)) return;
    const { pairCount } = assessDraft(text);
    this.#set({ kind: "printing" });
    const outcome = await this.issue(text, ttlSeconds);
    this.#set(
      outcome.kind === "issued"
        ? { kind: "printed", link: outcome.link, expiresAt: outcome.expiresAt, pairCount }
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
