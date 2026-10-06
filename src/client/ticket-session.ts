// Key custody for the recipient's tab. Views never touch the address bar, history, or storage
// for the ticket; they ask this module for the ticket and tell it when the ticket is finished.
//
// Rules:
// - the fragment is scrubbed from the address bar (and the current history entry) first,
//   unconditionally, before anything else can fail;
// - an unopened ticket survives a refresh of this tab only (sessionStorage);
// - once a ticket is opened or found void, it's forgotten, so refreshing, going back, or
//   reopening the tab lands on the create page instead.

import { parseTicketFragment, type FragmentReading } from "../core/ticket";

const STORAGE_KEY = "ticket";

/** The slice of the browser this module needs, so tests can supply their own. */
export interface TicketBrowser {
  location: { hash: string };
  history: { replaceState(data: unknown, unused: string, url: string): void };
  sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

/** Takes the ticket from the link, or from this tab's storage after a refresh. */
export function captureTicket(browser: TicketBrowser = window): FragmentReading {
  const fragment = browser.location.hash;
  if (fragment) browser.history.replaceState(null, "", "/t");

  const fromLink = parseTicketFragment(fragment);
  if (fromLink.kind === "ticket") {
    attempt(() => browser.sessionStorage.setItem(STORAGE_KEY, fragment.replace(/^#/, "")));
    return fromLink;
  }
  if (fromLink.kind !== "missing") return fromLink;

  const stored = attempt(() => browser.sessionStorage.getItem(STORAGE_KEY)) ?? "";
  const fromStorage = parseTicketFragment(stored);
  if (fromStorage.kind === "ticket") return fromStorage;
  forgetTicket(browser);
  return { kind: "missing" };
}

export function forgetTicket(browser: TicketBrowser = window) {
  attempt(() => browser.sessionStorage.removeItem(STORAGE_KEY));
}

// Storage can throw (privacy modes, quotas). Losing refresh support is fine; failing isn't.
function attempt<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch {
    return undefined;
  }
}
