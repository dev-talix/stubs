import { claimSecret, secretStatus } from "./api";
import { TICKET_KEY_PATTERN, deriveTicket, open, type Ticket } from "./crypto";
import { copyText, flashLabel, formatStamp, h, playAnimation, setChildren } from "./dom";
import { parseDotenv } from "./dotenv";
import { feed, perforation, receiptHead, rule, voidStamp } from "./receipt";

type Announce = (message: string) => void;

const KEY_STORAGE = "snapkey:ticket";

/**
 * Moves the key out of the address bar, so it doesn't sit in browser history as a live link,
 * into storage scoped to this tab, so a refresh before tearing still works.
 */
function takeTicketKey(): string {
  const fromLink = location.hash.slice(1);
  try {
    if (fromLink) sessionStorage.setItem(KEY_STORAGE, fromLink);
    history.replaceState(null, "", "/t");
    return sessionStorage.getItem(KEY_STORAGE) ?? fromLink;
  } catch {
    return fromLink;
  }
}

function forgetTicketKey() {
  try {
    sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    // Storage unavailable: nothing was kept.
  }
}

export async function renderReveal(receipt: HTMLElement, announce: Announce, key = takeTicketKey()) {
  if (!TICKET_KEY_PATTERN.test(key)) {
    forgetTicketKey();
    renderMessage(receipt, {
      title: "NO TICKET",
      body:
        "There's no key to open. If you already tore this ticket, it's gone. Otherwise the link " +
        "was cut short: everything after the # is the key, so ask the sender for the whole link.",
    });
    return;
  }

  receipt.replaceChildren(
    receiptHead("ENV TICKET"),
    rule(),
    h("p", { class: "checking", role: "status" }, "CHECKING TICKET…"),
  );

  let ticket: Ticket;
  try {
    ticket = await deriveTicket(key);
  } catch {
    renderMessage(receipt, {
      title: "CAN'T OPEN HERE",
      body: "This browser can't run the decryption this link needs. Try a current version of Chrome, Firefox, or Safari.",
    });
    return;
  }

  const status = await secretStatus(ticket.id);
  if (!status.ok) {
    if (status.failure === "not_found") return renderVoid(receipt, announce);
    return renderMessage(receipt, {
      title: "NO CONNECTION",
      body: "Couldn't reach the server to check this ticket. Nothing has been used. Try again.",
      retry: () => renderReveal(receipt, announce, key),
    });
  }

  renderSealed(receipt, ticket, status.data.expiresAt, announce);
}

function renderSealed(receipt: HTMLElement, ticket: Ticket, expiresAt: number, announce: Announce) {
  const tear = h("button", { type: "button", class: "print" }, "TEAR TO REVEAL");
  const error = h("p", { class: "error", role: "alert" });
  const stub = h(
    "div",
    { class: "stub" },
    perforation("TEAR HERE"),
    h(
      "p",
      { class: "fine" },
      "It opens once. Tearing it voids the link for everyone, including you, " +
        "so be ready to copy what's inside.",
    ),
    tear,
    error,
  );

  tear.addEventListener("click", async () => {
    tear.disabled = true;
    tear.textContent = "TEARING…";
    error.textContent = "";

    const claim = await claimSecret(ticket.id);
    if (!claim.ok) {
      if (claim.failure === "not_found") return renderVoid(receipt, announce);
      tear.disabled = false;
      tear.textContent = "TEAR TO REVEAL";
      error.textContent =
        "Couldn't reach the server. If the ticket did open, trying again will show it as void.";
      return;
    }

    forgetTicketKey();
    let plaintext: string;
    try {
      plaintext = await open(claim.data, ticket);
    } catch {
      return renderMessage(receipt, {
        title: "WON'T DECRYPT",
        body:
          "The ticket opened but its contents didn't match this link, so it may have been altered. " +
          "It's void now. Ask the sender for a new one.",
        stamped: true,
      });
    }

    await playAnimation(stub, "is-torn");
    renderOpened(receipt, plaintext, announce);
  });

  receipt.replaceChildren(
    receiptHead("ENV TICKET"),
    rule(),
    h("p", { class: "admit" }, "ADMIT ONE"),
    h("p", { class: "ticket-facts" }, `VALID UNTIL ${formatStamp(expiresAt)}`),
    h(
      "p",
      { class: "lede" },
      "Someone sent you environment variables. They're encrypted, and only this link can open them.",
    ),
    stub,
  );
  announce("Ticket found. It can be opened once.");
}

function renderOpened(receipt: HTMLElement, plaintext: string, announce: Announce) {
  window.addEventListener("beforeunload", (event) => event.preventDefault());

  const lines = parseDotenv(plaintext);
  const pairs = lines.filter((line) => line.kind === "pair");
  const unreadable = lines.length - pairs.length;

  const list = h(
    "ol",
    { class: "secrets", "aria-label": "Environment variables" },
    ...pairs.map((pair) => {
      const copy = h(
        "button",
        { type: "button", class: "copy", "aria-label": `Copy value of ${pair.key}` },
        "COPY",
      );
      copy.addEventListener("click", async () => {
        if (await copyText(pair.value)) {
          flashLabel(copy, "COPIED");
          announce(`${pair.key} copied.`);
        }
      });
      return h(
        "li",
        { class: "secret" },
        h("div", { class: "secret-head" }, h("span", { class: "key" }, pair.key), copy),
        h("code", { class: "value" }, pair.value === "" ? "(empty)" : pair.value),
      );
    }),
  );

  const copyAll = h("button", { type: "button", class: "print" }, "COPY ALL AS .ENV");
  copyAll.addEventListener("click", async () => {
    if (await copyText(plaintext)) {
      flashLabel(copyAll, "COPIED");
      announce("All values copied in .env format.");
    }
  });

  const download = h("button", { type: "button", class: "text-button" }, "DOWNLOAD .ENV");
  download.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([plaintext], { type: "text/plain" }));
    const anchor = h("a", { href: url, download: ".env" });
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  setChildren(
    receipt,
    receiptHead("ENV TICKET", voidStamp()),
    rule(),
    h("p", { class: "ticket-facts" }, `OPENED ${formatStamp(Date.now())}`),
    h(
      "p",
      { class: "lede" },
      "This page is the only copy left. The server deleted its copy when you opened it.",
    ),
    rule(),
    h("div", { class: "unroll" }, pairs.length > 0 ? list : h("pre", { class: "raw" }, plaintext)),
    unreadable > 0 &&
      h(
        "p",
        { class: "fine" },
        `${unreadable} ${unreadable === 1 ? "line wasn't" : "lines weren't"} KEY=VALUE. ` +
          "Copy all includes them exactly as sent.",
      ),
    rule(),
    copyAll,
    download,
  );
  announce(`Ticket opened. ${pairs.length} values ready to copy. The link is now void.`);
  copyAll.focus();
}

function renderVoid(receipt: HTMLElement, announce: Announce) {
  forgetTicketKey();
  renderMessage(receipt, {
    title: "NOTHING HERE",
    body:
      "This ticket was already opened, or it expired. Either way it's gone for good. " +
      "Ask whoever sent it for a new one.",
    stamped: true,
  });
  announce("This ticket is void.");
}

function renderMessage(
  receipt: HTMLElement,
  message: { title: string; body: string; stamped?: boolean; retry?: () => void },
) {
  const retry =
    message.retry &&
    h("button", { type: "button", class: "print" }, "TRY AGAIN");
  if (retry && message.retry) retry.addEventListener("click", message.retry);

  const home = h("a", { class: "text-button", href: "/" }, "PRINT YOUR OWN");

  setChildren(
    receipt,
    receiptHead("ENV TICKET", message.stamped ? voidStamp() : undefined),
    rule(),
    h("p", { class: "admit" }, message.title),
    h("p", { class: "lede" }, message.body),
    rule(),
    retry,
    home,
  );
  feed(receipt);
}
