import { afterEach, describe, expect, it, vi } from "vitest";
import { agentInstructions, renderCreate } from "../../src/client/create";
import { formatLines } from "../../src/client/format";
import { MAX_PLAINTEXT_BYTES } from "../../src/shared/protocol";
import { NPX_STUBS } from "../../src/shared/stubs-cli";

vi.mock("../../src/core/lock", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/core/lock")>(),
  supportsLocking: () => Promise.resolve(true),
}));

// The client suite runs in Node. Keep this DOM stand-in local to the create view tests.
class Element extends EventTarget {
  children: (Element | string)[] = [];
  attributes = new Map<string, string>();
  value = "";
  disabled = false;
  readOnly = false;
  hidden = false;
  classList = {
    toggle: (name: string, force: boolean) => {
      const names = new Set((this.getAttribute("class") ?? "").split(" ").filter(Boolean));
      if (force) names.add(name);
      else names.delete(name);
      this.setAttribute("class", [...names].join(" "));
    },
    add: (name: string) => this.classList.toggle(name, true),
    remove: (name: string) => this.classList.toggle(name, false),
  };

  constructor(readonly tagName: string) {
    super();
  }

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  append(...children: (Element | string)[]) { this.children.push(...children); }
  replaceChildren(...children: (Element | string)[]) { this.children = children; }
  get textContent(): string {
    return this.children.map((child) => typeof child === "string" ? child : child.textContent).join("");
  }
  set textContent(text: string) { this.children = [text]; }
}

function descendants(element: Element): Element[] {
  return element.children.flatMap((child) => typeof child === "string" ? [] : [child, ...descendants(child)]);
}

function setupCreate() {
  vi.stubGlobal("document", {
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => text,
  });
  const receipt = new Element("article");
  const announce = vi.fn();
  renderCreate(receipt as unknown as HTMLElement, announce, vi.fn());
  const find = (name: string, value: string) => descendants(receipt).find((el) => el.getAttribute(name) === value)!;
  const edit = (input: Element, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input"));
  };
  return { receipt, find, edit, announce, input: find("id", "env-input"), lockInput: find("id", "lock-input") };
}

afterEach(() => vi.unstubAllGlobals());

describe("create draft", () => {
  it("marks invalid recipients and connects their hint, clearing the state for valid or empty ids", () => {
    const { find, edit, announce, lockInput } = setupCreate();
    const hint = find("id", lockInput.getAttribute("aria-describedby")!);
    expect(lockInput.getAttribute("aria-invalid")).toBeNull();
    edit(lockInput, "stubs1abc");
    expect(lockInput.getAttribute("aria-invalid")).toBeNull();
    lockInput.dispatchEvent(new Event("blur"));
    expect(lockInput.getAttribute("aria-invalid")).toBe("true");
    expect(hint.textContent).toContain("cut short");
    expect(hint.textContent).toContain("Their stubs id comes from init");
    expect(announce).toHaveBeenCalledWith(expect.stringContaining("cut short"));
    edit(lockInput, "stubs1" + "_".repeat(43));
    expect(lockInput.getAttribute("aria-invalid")).toBe("true");
    expect(hint.textContent).toContain("Not a valid stubs id.");
    edit(lockInput, "stubs1" + "k".repeat(43));
    expect(lockInput.getAttribute("aria-invalid")).toBeNull();
    expect(hint.textContent).not.toContain("Not a valid stubs id.");
    edit(lockInput, "bad");
    edit(lockInput, "");
    expect(lockInput.getAttribute("aria-invalid")).toBeNull();
  });

  it("hides mask glyphs from assistive tech and describes each kind of preview row", () => {
    const { find, edit, input } = setupCreate();
    edit(input, "SECRET=private-value\nEMPTY=\nplain text");
    const rows = find("aria-label", "Items on this ticket").children as Element[];
    expect(rows).toHaveLength(3);
    for (const [i, label] of ["hidden", "empty", "not a key/value line"].entries()) {
      const parts = descendants(rows[i]!);
      expect(parts.find((el) => el.getAttribute("class") === "mask")?.getAttribute("aria-hidden")).toBe("true");
      expect(parts.find((el) => el.getAttribute("class") === "sr-only")?.textContent.trim()).toBe(label);
    }
    expect(rows.map((row) => row.textContent).join(" ")).not.toContain("private-value");
  });

  it.each([false, true])("caps the preview and preserves the full count, plain text: %s", (plainText) => {
    const { receipt, find, edit, input } = setupCreate();
    const lines = Array.from({ length: 462 }, (_, i) => plainText ? `text ${i}` : `KEY_${i}=value`);
    edit(input, lines.join("\n"));
    const items = find("aria-label", "Items on this ticket");
    expect(items.children).toHaveLength(51);
    expect((items.children[50] as Element).textContent).toBe("+ 412 more lines");
    expect(receipt.textContent).toContain(plainText ? "462 LINES" : "ITEMS 462");
    edit(input, lines.slice(0, 50).join("\n"));
    expect(items.children).toHaveLength(50);
    expect(items.textContent).not.toContain("more lines");
    edit(input, "");
    expect(items.children).toHaveLength(1);
    expect(items.textContent).toBe("Nothing to print yet.");
  });

  it("shows the size error and disables printing above the byte limit, then clears both", () => {
    const { find, edit, input } = setupCreate();
    const error = find("role", "alert");
    const print = find("class", "print");
    const atLimit = "KEY=" + "x".repeat(MAX_PLAINTEXT_BYTES - 4);
    edit(input, atLimit);
    expect(error.textContent).toBe("");
    expect(print.disabled).toBe(false);
    edit(input, atLimit + "x");
    expect(error.textContent).toBe("Too long to print. The limit is 32 KB.");
    expect(print.disabled).toBe(true);
    edit(input, atLimit);
    expect(error.textContent).toBe("");
    expect(print.disabled).toBe(false);
  });
});

describe("agent instructions", () => {
  it.each(["v1.key", "v2.recipient.ephemeral.wrapped"])("quotes the complete %s link and pins the CLI", (fragment) => {
    const link = `https://stubs.talix.app/t#${fragment}`;
    expect(agentInstructions(link)).toBe(
      `Pull these .env values with: ${NPX_STUBS} pull '${link}'\n` +
      "It writes .env.local and prints only the key names. Run the command instead of opening or fetching the link.",
    );
  });
});

describe("plain-text line counts", () => {
  it.each([[1, "1 LINE"], [2, "2 LINES"]] as const)("labels %s lines", (count, label) => {
    expect(formatLines(count)).toBe(label);
  });
});
