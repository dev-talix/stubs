// The receipt screen: every view shows its content through showReceipt, which owns the header,
// the dashed rules between sections, the VOID stamp, paper feed, announcements, and focus.

import { h, playAnimation, type Child } from "./dom";
import { formatPrintTime } from "./format";

export type Announce = (message: string) => void;

export interface ReceiptScreen {
  /** Groups of content; a dashed rule is printed between consecutive groups. */
  sections: Child[][];
  /** Stamp the ticket VOID. */
  stamped?: boolean;
  /** Play the paper-feed animation, as if freshly printed. */
  feed?: boolean;
  /** Spoken to screen reader users once the screen is up. */
  message?: string;
  focus?: HTMLElement;
}

export function showReceipt(receipt: HTMLElement, screen: ReceiptScreen, announce: Announce) {
  detachStub(receipt);

  const printed = Date.now();
  const head = h(
    "header",
    { class: "receipt-head" },
    h("p", { class: "brand" }, "SNAPKEY"),
    h(
      "p",
      { class: "receipt-meta" },
      h("span", {}, "ENV TICKET"),
      h("time", { datetime: new Date(printed).toISOString() }, formatPrintTime(printed)),
    ),
    screen.stamped && h("div", { class: "stamp", "aria-hidden": "true" }, "VOID"),
  );

  const body: Node[] = [];
  for (const section of [[head], ...screen.sections]) {
    const nodes = section.filter((child): child is Node | string => !!child);
    if (nodes.length === 0) continue;
    if (body.length > 0) body.push(h("hr", { class: "rule" }));
    body.push(...nodes.map((node) => (typeof node === "string" ? document.createTextNode(node) : node)));
  }
  receipt.replaceChildren(...body);

  if (screen.feed) {
    receipt.classList.remove("is-feeding");
    void receipt.offsetWidth; // restart the animation
    receipt.classList.add("is-feeding");
  }
  if (screen.message) announce(screen.message);
  screen.focus?.focus();
}

export function perforation(label: string): HTMLElement {
  return h("div", { class: "perf", role: "presentation" }, h("span", {}, label));
}

/** Decorative barcode. Random on purpose: it must never encode anything from the link. */
export function barcode(): HTMLElement {
  const bars = h("div", { class: "barcode", "aria-hidden": "true" });
  for (const w of crypto.getRandomValues(new Uint8Array(44))) {
    // CSSOM, not a style attribute: the CSP blocks inline style attributes.
    const bar = h("span");
    bar.style.setProperty("--w", `${(w % 3) + 1}px`);
    bars.append(bar);
  }
  return bars;
}

/**
 * Hangs a tear-off stub below the receipt as its own strip of paper. Until it's torn the two
 * read as one continuous receipt; tearing leaves the receipt with a ragged edge.
 */
export function attachStub(receipt: HTMLElement, stub: HTMLElement) {
  detachStub(receipt);
  stub.classList.add("receipt", "stub-paper");
  receipt.classList.add("has-stub");
  receipt.after(stub);
}

/** Tears the stub away: the receipt gets its torn edge back and the stub drops into the dark. */
export async function tearStub(receipt: HTMLElement, stub: HTMLElement) {
  receipt.classList.remove("has-stub");
  await playAnimation(stub, "is-torn");
  stub.remove();
}

function detachStub(receipt: HTMLElement) {
  receipt.classList.remove("has-stub");
  receipt.parentElement?.querySelector(".stub-paper")?.remove();
}
