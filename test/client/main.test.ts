import { afterEach, expect, it, vi } from "vitest";
import { copyText, selectText } from "../../src/client/copy";

vi.mock("../../src/client/copy", () => ({ copyText: vi.fn(), selectText: vi.fn() }));
vi.mock("../../src/client/create", () => ({ renderCreate: vi.fn() }));
vi.mock("../../src/client/reveal", () => ({ renderReveal: vi.fn() }));
vi.mock("../../src/client/analytics", () => ({ readAcquisition: vi.fn(), track: vi.fn() }));
vi.mock("../../src/client/ticket-session", () => ({
  captureTicket: () => ({ kind: "missing" }), forgetTicket: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

it("selects the footer snippet and announces manual copying on clipboard refusal", async () => {
  const button = { dataset: { copy: "snippet" }, addEventListener: vi.fn(), textContent: "COPY" };
  const source = { textContent: "snippet text" };
  const announcer = { textContent: "" };
  vi.stubGlobal("document", {
    querySelector: (selector: string) => selector === "#announcer" ? announcer : {},
    querySelectorAll: () => [button],
    getElementById: () => source,
  });
  vi.stubGlobal("location", { pathname: "/t", replace: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
  vi.mocked(copyText).mockResolvedValue(false);
  await import("../../src/client/main");
  await button.addEventListener.mock.calls[0]![1]();
  expect(copyText).toHaveBeenCalledWith("snippet text");
  expect(selectText).toHaveBeenCalledWith(source);
  expect(announcer.textContent).toBe("Copy blocked. The snippet is selected. Press Ctrl+C or Cmd+C.");
  expect(button.textContent).toBe("COPY");
});
