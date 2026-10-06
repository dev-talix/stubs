import "@fontsource/fragment-mono/400.css";
import "./styles.css";
import { track } from "./analytics";
import { renderCreate } from "./create";
import { renderReveal } from "./reveal";
import { issueTicket, type Transport } from "../core/ticket";
import { captureTicket, forgetTicket } from "./ticket-session";

const receipt = document.querySelector<HTMLElement>("#receipt");
const announcer = document.querySelector<HTMLElement>("#announcer");
if (!receipt || !announcer) throw new Error("Page shell is missing");

function announce(message: string) {
  announcer!.textContent = "";
  // A fresh text node after clearing makes screen readers repeat identical messages.
  requestAnimationFrame(() => (announcer!.textContent = message));
}

const transport: Transport = (path, init) => fetch(path, init);

function showCreatePage() {
  if (location.pathname !== "/") history.replaceState(null, "", "/");
  track({ event: "page_viewed", properties: { path: "/" } });
  renderCreate(receipt!, announce, async (text, ttl, lockTo) => {
    const outcome = await issueTicket(text, ttl, transport, location.origin, lockTo ? { lockTo } : {});
    if (outcome.kind === "issued") track({ event: "stub_generated", properties: { ttl_seconds: ttl } });
    return outcome;
  });
}

if (location.pathname.replace(/\/+$/, "") === "/t") {
  const reading = captureTicket();
  if (reading.kind === "missing") {
    // No ticket in the link or in this tab: it was already used here, or never existed.
    location.replace("/");
  } else {
    document.title = "A stub for you · Stubs";
    // Captured above, so the key is already out of the address bar. Only the path is sent.
    track({ event: "page_viewed", properties: { path: "/t" } });
    let finished = false;

    // A used ticket must not come back. Blank the page before the browser snapshots it for
    // back/forward navigation. If any snapshot of this page is restored, don't trust it: the
    // ticket may have been used since, in this tab or elsewhere. A finished one goes home; any
    // other reloads, which re-reads this tab's ticket (or goes home if it's been forgotten).
    window.addEventListener("pagehide", () => {
      if (finished) receipt.replaceChildren();
    });
    window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      if (finished) location.replace("/");
      else location.reload();
    });
    // Another ticket link opened in this tab only changes the fragment, which doesn't load a
    // new page. Reload so the new key goes through capture (and gets scrubbed) like any other.
    window.addEventListener("hashchange", () => location.reload());

    void renderReveal(receipt, reading, {
      transport,
      announce,
      finish: () => {
        finished = true;
        forgetTicket();
      },
    });
  }
} else {
  showCreatePage();
}
