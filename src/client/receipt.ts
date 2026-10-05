import { formatPrintTime, h } from "./dom";

/** The header every receipt starts with: brand, kind of ticket, and print time. */
export function receiptHead(kind: string, stamp?: HTMLElement): HTMLElement {
  const printed = Date.now();
  return h(
    "header",
    { class: "receipt-head" },
    h("p", { class: "brand" }, "SNAPKEY"),
    h(
      "p",
      { class: "receipt-meta" },
      h("span", {}, kind),
      h("time", { datetime: new Date(printed).toISOString() }, formatPrintTime(printed)),
    ),
    stamp,
  );
}

export function rule(): HTMLElement {
  return h("hr", { class: "rule" });
}

export function perforation(label: string): HTMLElement {
  return h("div", { class: "perf", role: "presentation" }, h("span", {}, label));
}

export function voidStamp(): HTMLElement {
  return h("div", { class: "stamp", "aria-hidden": "true" }, "VOID");
}

/** Decorative barcode. Random on purpose: it must never encode anything from the link. */
export function barcode(): HTMLElement {
  const bars = h("div", { class: "barcode", "aria-hidden": "true" });
  const widths = crypto.getRandomValues(new Uint8Array(44));
  for (const w of widths) {
    // CSSOM, not a style attribute: the CSP blocks inline style attributes.
    const bar = h("span");
    bar.style.setProperty("--w", `${(w % 3) + 1}px`);
    bars.append(bar);
  }
  return bars;
}

/** Plays the paper-feed animation on a freshly printed receipt. */
export function feed(receipt: HTMLElement) {
  receipt.classList.remove("is-feeding");
  void receipt.offsetWidth;
  receipt.classList.add("is-feeding");
}
