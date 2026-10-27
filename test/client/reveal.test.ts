import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openedLabels, renderReveal } from "../../src/client/reveal";
import { pairsOf, parseDotenv } from "../../src/core/dotenv";
import { inspectTicket, parseTicketFragment, revealTicket } from "../../src/core/ticket";
import { copyButton, selectText } from "../../src/client/copy";
import { h } from "../../src/client/dom";
import { showReceipt } from "../../src/client/receipt";

vi.mock("../../src/client/dom", () => ({
  h: vi.fn((_tag, attrs = {}, ...children) => ({
    textContent: children.filter((child) => typeof child === "string").join(""),
    hidden: attrs.hidden === true,
    addEventListener: vi.fn(),
    replaceChildren: vi.fn(),
  })),
}));

vi.mock("../../src/client/copy", () => ({
  copyButton: vi.fn(() => ({})),
  selectText: vi.fn(),
}));

vi.mock("../../src/client/receipt", () => ({
  showReceipt: vi.fn(),
  attachStub: vi.fn(),
  tearStub: vi.fn(),
  perforation: vi.fn(),
}));

vi.mock("../../src/core/ticket", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/core/ticket")>(),
  inspectTicket: vi.fn(),
  revealTicket: vi.fn(),
}));

describe("reveal screens", () => {
  const receipt = {} as HTMLElement;
  const announce = vi.fn();
  const finish = vi.fn();
  const context = { transport: vi.fn(), announce, finish };
  const capability = "k".repeat(43);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("location", { origin: "https://stubs.talix.app" });
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    vi.mocked(inspectTicket).mockResolvedValue({ kind: "sealed", expiresAt: Date.now() });
  });

  afterEach(() => vi.unstubAllGlobals());

  async function sealed() {
    const reading = parseTicketFragment(`#v1.${capability}`);
    if (reading.kind !== "ticket") throw new Error("Invalid test ticket");
    await renderReveal(receipt, reading, context);
  }

  async function click(label: string) {
    const button = vi.mocked(h).mock.results.map((result) => result.value as HTMLElement)
      .find((element) => element.textContent === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    const listener = vi.mocked(button.addEventListener).mock.calls[0]![1] as () => Promise<void>;
    await listener();
  }

  async function opened(plaintext: string) {
    vi.mocked(revealTicket).mockResolvedValue({ kind: "opened", plaintext });
    await sealed();
    await click("TEAR TO REVEAL");
  }

  function lastScreen() {
    return vi.mocked(showReceipt).mock.calls.at(-1)![1];
  }

  function copy(label: string) {
    return vi.mocked(copyButton).mock.calls.map(([options]) => options)
      .find((options) => options.ariaLabel === label || (!options.ariaLabel && options.label === label))!;
  }

  it("doesn't request focus while the initial ticket is checked and shown", async () => {
    await sealed();
    expect(vi.mocked(showReceipt).mock.calls.every(([, screen]) => !screen.focusHeading)).toBe(true);
    expect(h).toHaveBeenCalledWith("h2", expect.objectContaining({ class: "checking" }), "CHECKING TICKET…");
    expect(h).toHaveBeenCalledWith("h2", { class: "admit" }, "ADMIT ONE");
  });

  it("offers the full pull command for manual copying without consuming the ticket", async () => {
    const locked = `${"e".repeat(43)}.${"w".repeat(80)}`;
    await renderReveal(receipt, { kind: "locked", locked }, context);
    expect(selectText).not.toHaveBeenCalled();
    expect(inspectTicket).not.toHaveBeenCalled();
    const options = copy("Copy the pull command");
    options.onRefused!();
    const selected = vi.mocked(selectText).mock.calls.at(-1)![0];
    expect(selected.textContent).toBe(options.text());
    expect(selected.textContent).toContain(`/t#v2.${locked}`);
    expect(announce).toHaveBeenLastCalledWith(expect.stringContaining("command is selected"));
    expect(finish).not.toHaveBeenCalled();
    expect(lastScreen().focusHeading).toBeUndefined();
  });

  it("selects the decoded value when per-value copying is refused", async () => {
    await opened('KEY="hello\\nworld"');
    const options = copy("Copy value of KEY");
    options.onRefused!();
    const selected = vi.mocked(selectText).mock.calls.at(-1)![0];
    expect(selected.textContent).toBe(options.text());
    expect(selected.textContent).toBe("hello\nworld");
    expect(announce).toHaveBeenLastCalledWith(expect.stringContaining("value is selected"));
  });

  it.each(["KEY=value\nstray text\n", "plain text\nsecond line\n"])(
    "selects all original text on clipboard refusal for %j", async (plaintext) => {
      await opened(plaintext);
      copy(plaintext.startsWith("KEY=") ? "COPY ALL AS .ENV" : "COPY").onRefused!();
      const selected = vi.mocked(selectText).mock.calls.at(-1)![0];
      expect(selected.textContent).toBe(plaintext);
      expect(selected.hidden).toBe(false);
      const unrollIndex = vi.mocked(h).mock.calls.findIndex(([, attrs]) => attrs?.class === "unroll");
      const unroll = vi.mocked(h).mock.results[unrollIndex]!.value as HTMLElement;
      expect(unroll.replaceChildren).toHaveBeenCalledWith(selected);
      expect(announce).toHaveBeenLastCalledWith(expect.stringContaining("text is selected"));
    },
  );

  it("requests heading focus after opening and limits its deletion claim to the server copy", async () => {
    await opened("KEY=value");
    expect(lastScreen().focusHeading).toBe(true);
    expect(lastScreen().focus).toBeUndefined();
    expect(h).toHaveBeenCalledWith("h2", { class: "ticket-facts" }, expect.stringContaining("OPENED"));
    expect(h).toHaveBeenCalledWith("p", { class: "lede" },
      "The server deleted its copy. Save what you need before leaving. This page won't come back.");
    expect(finish).toHaveBeenCalledOnce();
  });

  it.each(["void", "tampered"] as const)("requests heading focus after a tear reports %s", async (kind) => {
    vi.mocked(revealTicket).mockResolvedValue({ kind });
    await sealed();
    await click("TEAR TO REVEAL");
    expect(lastScreen().focusHeading).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
  });

  it("leaves initial errors unfocused and focuses screens reached by retry", async () => {
    vi.mocked(inspectTicket).mockResolvedValueOnce({ kind: "failed", reason: "network" });
    await sealed();
    expect(lastScreen().focusHeading).toBe(false);
    await click("TRY AGAIN");
    expect(lastScreen().focusHeading).toBe(true);
  });
});

describe("opened ticket labels", () => {
  it("offers plain-text copying and download when no pairs exist", () => {
    expect(openedLabels(pairsOf(parseDotenv("sk_live_abc123")).length)).toEqual({
      copy: "COPY",
      copied: "Copied.",
      download: "DOWNLOAD",
      filename: "stub.txt",
      message: "Ticket opened. Text is ready to copy. The link is now void.",
    });
  });

  it.each(["KEY=value", "KEY=value\nstray text"])("keeps .env actions for %j", (text) => {
    expect(openedLabels(pairsOf(parseDotenv(text)).length)).toEqual({
      copy: "COPY ALL AS .ENV",
      copied: "All values copied in .env format.",
      download: "DOWNLOAD .ENV",
      filename: ".env",
      message: "Ticket opened. 1 value ready to copy. The link is now void.",
    });
  });
});
