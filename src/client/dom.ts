export type Child = Node | string | false | null | undefined;
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
