import { describe, expect, it } from "vitest";
import { captureTicket, forgetTicket, type TicketBrowser } from "../../src/client/ticket-session";

const FRAGMENT = `#v1.${"k".repeat(43)}`;

function fakeBrowser(hash: string, options: { storageThrows?: boolean } = {}) {
  const storage = new Map<string, string>();
  const urls: string[] = [];
  const guard = () => {
    if (options.storageThrows) throw new DOMException("blocked", "SecurityError");
  };
  const browser: TicketBrowser = {
    location: { hash },
    history: { replaceState: (_d, _u, url) => urls.push(url) },
    sessionStorage: {
      getItem: (k) => (guard(), storage.get(k) ?? null),
      setItem: (k, v) => (guard(), void storage.set(k, v)),
      removeItem: (k) => (guard(), void storage.delete(k)),
    },
  };
  return { browser, storage, urls };
}

describe("captureTicket", () => {
  it("scrubs the fragment from the address bar", () => {
    const { browser, urls } = fakeBrowser(FRAGMENT);
    expect(captureTicket(browser).kind).toBe("ticket");
    expect(urls).toEqual(["/t"]);
  });

  it("still scrubs and returns the ticket when storage is blocked", () => {
    const { browser, urls } = fakeBrowser(FRAGMENT, { storageThrows: true });
    expect(captureTicket(browser).kind).toBe("ticket");
    expect(urls).toEqual(["/t"]);
  });

  it("survives a refresh of the same tab until it's forgotten", () => {
    const first = fakeBrowser(FRAGMENT);
    captureTicket(first.browser);
    const refreshed: TicketBrowser = { ...first.browser, location: { hash: "" } };
    expect(captureTicket(refreshed).kind).toBe("ticket");

    forgetTicket(refreshed);
    expect(captureTicket(refreshed).kind).toBe("missing");
  });

  it("doesn't keep malformed fragments", () => {
    const { browser, storage, urls } = fakeBrowser("#v1.short");
    expect(captureTicket(browser).kind).toBe("malformed");
    expect(storage.size).toBe(0);
    expect(urls).toEqual(["/t"]);
  });

  it("prefers a new link over a ticket stored earlier in the tab", () => {
    const first = fakeBrowser(FRAGMENT);
    captureTicket(first.browser);
    const other = `#v1.${"z".repeat(43)}`;
    const next: TicketBrowser = { ...first.browser, location: { hash: other } };
    expect(captureTicket(next)).toEqual({ kind: "ticket", capability: "z".repeat(43) });
  });

  it("clears unreadable stored values", () => {
    const { browser, storage } = fakeBrowser("");
    storage.set("ticket", "garbage");
    expect(captureTicket(browser).kind).toBe("missing");
    expect(storage.size).toBe(0);
  });
});
