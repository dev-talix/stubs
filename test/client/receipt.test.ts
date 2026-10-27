import { beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "../../src/client/dom";
import { showReceipt } from "../../src/client/receipt";

vi.mock("../../src/client/dom", () => ({
  h: vi.fn(() => ({ focus: vi.fn(), setAttribute: vi.fn() })),
}));

describe("receipt headings and focus", () => {
  beforeEach(() => vi.clearAllMocks());

  function receipt(sectionHeading = true) {
    const heading = { focus: vi.fn(), setAttribute: vi.fn() };
    const brand = { focus: vi.fn(), setAttribute: vi.fn() };
    const element = {
      classList: { remove: vi.fn() },
      replaceChildren: vi.fn(),
      querySelector: vi.fn((selector) => selector === "h2" ? (sectionHeading ? heading : null) : brand),
    } as unknown as HTMLElement;
    return { element, heading, brand };
  }

  it("renders the brand as h1 and leaves initial focus alone", () => {
    const { element, heading, brand } = receipt();
    showReceipt(element, { sections: [] }, vi.fn());
    expect(h).toHaveBeenCalledWith("h1", { class: "brand" }, "STUBS");
    expect(heading.focus).not.toHaveBeenCalled();
    expect(brand.focus).not.toHaveBeenCalled();
  });

  it("preserves an explicit focus target unless heading focus is requested", () => {
    const { element, heading } = receipt();
    const focus = { focus: vi.fn() } as unknown as HTMLElement;
    showReceipt(element, { sections: [], focus }, vi.fn());
    expect(focus.focus).toHaveBeenCalledOnce();
    showReceipt(element, { sections: [], focus, focusHeading: true }, vi.fn());
    expect(focus.focus).toHaveBeenCalledOnce();
    expect(heading.setAttribute).toHaveBeenCalledWith("tabindex", "-1");
    expect(heading.focus).toHaveBeenCalledOnce();
  });

  it("uses the brand heading when the new screen has no section heading", () => {
    const { element, brand } = receipt(false);
    showReceipt(element, { sections: [], focusHeading: true }, vi.fn());
    expect(brand.setAttribute).toHaveBeenCalledWith("tabindex", "-1");
    expect(brand.focus).toHaveBeenCalledOnce();
  });
});
