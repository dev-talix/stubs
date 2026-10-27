import { h } from "./dom";

type Announce = (message: string) => void;

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Select visible text for manual copying when clipboard access is blocked. */
export function selectText(element: HTMLElement) {
  element.setAttribute("tabindex", "-1");
  element.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

interface CopyButtonOptions {
  label: string;
  className: string;
  text: () => string;
  announce: Announce;
  copiedMessage: string;
  ariaLabel?: string;
  /** Called when the clipboard refuses, so the caller can offer a manual path. */
  onRefused?: () => void;
}

/** A button that copies, says "COPIED" for a moment, and tells screen reader users. */
export function copyButton(options: CopyButtonOptions): HTMLButtonElement {
  const button = h(
    "button",
    { type: "button", class: options.className, "aria-label": options.ariaLabel },
    options.label,
  );
  let timer: number | undefined;
  button.addEventListener("click", async () => {
    if (!(await copyText(options.text()))) {
      options.onRefused?.();
      return;
    }
    button.textContent = "COPIED";
    options.announce(options.copiedMessage);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => (button.textContent = options.label), 1600);
  });
  return button;
}
