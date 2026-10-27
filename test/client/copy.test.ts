import { afterEach, describe, expect, it, vi } from "vitest";
import { copyButton, selectText } from "../../src/client/copy";

afterEach(() => vi.unstubAllGlobals());

describe("clipboard refusal", () => {
  it("calls the opt-in manual path without announcing success", async () => {
    const button = { setAttribute: vi.fn(), append: vi.fn(), addEventListener: vi.fn() };
    vi.stubGlobal("document", { createElement: () => button });
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
    const announce = vi.fn();
    const onRefused = vi.fn();
    copyButton({ label: "COPY", className: "copy", text: () => "secret", announce,
      copiedMessage: "Copied.", onRefused });
    await button.addEventListener.mock.calls[0]![1]();
    expect(onRefused).toHaveBeenCalledOnce();
    expect(announce).not.toHaveBeenCalled();
  });

  it("keeps refusal handling optional for existing callers", async () => {
    const button = { setAttribute: vi.fn(), append: vi.fn(), addEventListener: vi.fn() };
    vi.stubGlobal("document", { createElement: () => button });
    vi.stubGlobal("navigator", {});
    const announce = vi.fn();
    copyButton({ label: "COPY", className: "copy", text: () => "secret", announce,
      copiedMessage: "Copied." });
    await expect(button.addEventListener.mock.calls[0]![1]()).resolves.toBeUndefined();
    expect(announce).not.toHaveBeenCalled();
  });

  it("focuses and selects only the requested element's contents", () => {
    const element = { setAttribute: vi.fn(), focus: vi.fn() } as unknown as HTMLElement;
    const range = { selectNodeContents: vi.fn() };
    const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
    vi.stubGlobal("document", { createRange: () => range });
    vi.stubGlobal("window", { getSelection: () => selection });
    selectText(element);
    expect(element.setAttribute).toHaveBeenCalledWith("tabindex", "-1");
    expect(element.focus).toHaveBeenCalledOnce();
    expect(range.selectNodeContents).toHaveBeenCalledWith(element);
    expect(selection.removeAllRanges).toHaveBeenCalledOnce();
    expect(selection.addRange).toHaveBeenCalledWith(range);
  });
});
