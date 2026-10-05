import "@fontsource/fragment-mono/400.css";
import "./styles.css";
import { renderCreate } from "./create";
import { feed } from "./receipt";
import { renderReveal } from "./reveal";

const receipt = document.querySelector<HTMLElement>("#receipt");
const announcer = document.querySelector<HTMLElement>("#announcer");
if (!receipt || !announcer) throw new Error("Page shell is missing");

function announce(message: string) {
  announcer!.textContent = "";
  // A fresh text node after clearing makes screen readers repeat identical messages.
  requestAnimationFrame(() => (announcer!.textContent = message));
}

if (location.pathname.replace(/\/+$/, "") === "/t") {
  document.title = "A ticket for you · Snapkey";
  void renderReveal(receipt, announce);
} else {
  if (location.pathname !== "/") history.replaceState(null, "", "/");
  renderCreate(receipt, announce);
  feed(receipt);
}
