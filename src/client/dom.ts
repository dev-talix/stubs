type Child = Node | string | false | null | undefined;
type Attrs = Record<string, string | boolean | undefined>;

/** Minimal element builder. Strings become text nodes, never HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    el.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    el.append(child);
  }
  return el;
}

/** replaceChildren that skips the falsy placeholders conditional content leaves behind. */
export function setChildren(el: HTMLElement, ...children: Child[]) {
  el.replaceChildren(...children.filter((child): child is Node | string => !!child));
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Resolves when the element's animation ends, right away under reduced motion, and after
 * `maxMs` regardless, so a suppressed animation can never block what comes next.
 */
export function playAnimation(el: HTMLElement, className: string, maxMs = 900): Promise<void> {
  if (prefersReducedMotion()) return Promise.resolve();
  return new Promise((resolve) => {
    el.addEventListener("animationend", () => resolve(), { once: true });
    setTimeout(resolve, maxMs);
    el.classList.add(className);
  });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Swaps a button's label for a moment after a copy, for sighted and screen reader users. */
export function flashLabel(button: HTMLButtonElement, label: string, ms = 1600) {
  const original = button.dataset.label ?? button.textContent ?? "";
  button.dataset.label = original;
  button.textContent = label;
  window.clearTimeout(Number(button.dataset.timer));
  button.dataset.timer = String(
    window.setTimeout(() => {
      button.textContent = original;
    }, ms),
  );
}

const stampFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatStamp(epochMs: number): string {
  return stampFormat.format(new Date(epochMs)).toUpperCase();
}

// Short, receipt-style print time for the header, e.g. "05 OCT 17:26".
const printFormat = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatPrintTime(epochMs: number): string {
  return printFormat.format(new Date(epochMs)).replace(",", "").toUpperCase();
}
