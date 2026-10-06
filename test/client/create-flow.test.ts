import { describe, expect, it } from "vitest";
import { CreateFlow, assessDraft, type CreateState } from "../../src/client/create-flow";
import type { IssueOutcome } from "../../src/core/ticket";
import { MAX_PLAINTEXT_BYTES } from "../../src/shared/protocol";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup() {
  const calls: string[] = [];
  const recipients: string[] = [];
  const pending: ReturnType<typeof deferred<IssueOutcome>>[] = [];
  const states: CreateState["kind"][] = [];
  const flow = new CreateFlow(
    (text, _ttl, lockTo) => {
      calls.push(text);
      recipients.push(lockTo);
      const d = deferred<IssueOutcome>();
      pending.push(d);
      return d.promise;
    },
    (state) => states.push(state.kind),
  );
  return { flow, calls, recipients, pending, states };
}

const RECIPIENT = "stubs1" + "k".repeat(43);

describe("CreateFlow", () => {
  it("allows only one print in flight, even if the text changes", async () => {
    const { flow, calls, pending } = setup();
    const first = flow.submit("A=1", 3600);
    expect(flow.state.kind).toBe("printing");
    expect(flow.canSubmit("A=1\nB=2")).toBe(false);
    flow.edited();
    expect(flow.state.kind).toBe("printing");
    await flow.submit("A=1\nB=2", 3600);
    expect(calls).toEqual(["A=1"]);

    pending[0]!.resolve({ kind: "issued", link: "L", expiresAt: 9 });
    await first;
    expect(flow.state).toEqual({ kind: "printed", link: "L", expiresAt: 9, pairCount: 1, locked: false });
    expect(flow.canSubmit("A=1")).toBe(false);
  });

  it("passes a recipient through and marks the ticket locked", async () => {
    const { flow, recipients, pending } = setup();
    const run = flow.submit("A=1", 3600, RECIPIENT);
    pending[0]!.resolve({ kind: "issued", link: "L", expiresAt: 9 });
    await run;
    expect(recipients).toEqual([RECIPIENT]);
    expect(flow.state).toMatchObject({ kind: "printed", locked: true });
  });

  it("won't submit with a half-typed recipient", async () => {
    const { flow, calls } = setup();
    expect(flow.canSubmit("A=1", "stubs1abc")).toBe(false);
    expect(flow.canSubmit("A=1", "")).toBe(true);
    expect(flow.canSubmit("A=1", RECIPIENT)).toBe(true);
    await flow.submit("A=1", 3600, "stubs1abc");
    expect(calls).toEqual([]);
  });

  it("refuses empty or oversized drafts", async () => {
    const { flow, calls } = setup();
    await flow.submit("   ", 3600);
    await flow.submit("A=" + "x".repeat(MAX_PLAINTEXT_BYTES), 3600);
    expect(calls).toEqual([]);
    expect(flow.state.kind).toBe("editing");
  });

  it("clears a failure when the user edits, and revalidates on retry", async () => {
    const { flow, pending, calls } = setup();
    const first = flow.submit("A=1", 3600);
    pending[0]!.resolve({ kind: "failed", reason: "network" });
    await first;
    expect(flow.state).toEqual({ kind: "failed", reason: "network" });
    expect(flow.canSubmit("")).toBe(false);

    flow.edited();
    expect(flow.state.kind).toBe("editing");
    void flow.submit("B=2", 3600);
    expect(calls).toEqual(["A=1", "B=2"]);
  });

  it("turns a thrown issue into a failure instead of hanging in printing", async () => {
    const states: CreateState["kind"][] = [];
    const flow = new CreateFlow(() => Promise.reject(new Error("boom")), (s) => states.push(s.kind));
    await flow.submit("A=1", 3600);
    expect(states).toEqual(["printing", "failed"]);
    expect(flow.canSubmit("A=1")).toBe(true);
  });

  it("goes back to editing after printing another", async () => {
    const { flow, pending, states } = setup();
    const first = flow.submit("A=1", 3600);
    pending[0]!.resolve({ kind: "issued", link: "L", expiresAt: 9 });
    await first;
    flow.reset();
    expect(states).toEqual(["printing", "printed", "editing"]);
  });
});

describe("assessDraft", () => {
  it("counts pairs and bytes", () => {
    expect(assessDraft("A=1\n# c\nnope\nB=ü")).toMatchObject({ pairCount: 2, bytes: 17, printable: true });
    expect(assessDraft("")).toMatchObject({ pairCount: 0, printable: false, overLimit: false });
  });
});
