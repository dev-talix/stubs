import { copyButton } from "./copy";
import { NPX_STUBS } from "../shared/stubs-cli";
import { h } from "./dom";
import { pairsOf, parseDotenv } from "../core/dotenv";
import { formatStamp } from "./format";
import { attachStub, perforation, showReceipt, tearStub, type Announce } from "./receipt";
import {
  inspectTicket,
  lockedTicketLink,
  revealTicket,
  ticketLink,
  type FragmentReading,
  type TicketCapability,
  type Transport,
} from "../core/ticket";

export interface RevealContext {
  transport: Transport;
  announce: Announce;
  /** The ticket is used up or unusable: forget it so this tab can't come back to it. */
  finish: () => void;
}

export async function renderReveal(
  receipt: HTMLElement,
  reading: Exclude<FragmentReading, { kind: "missing" }>,
  context: RevealContext,
) {
  if (reading.kind === "malformed") {
    context.finish();
    return renderMessage(receipt, context, {
      title: "INCOMPLETE LINK",
      body: "The key after the # is cut short. Ask the sender for the whole link.",
    });
  }
  if (reading.kind === "locked") {
    // Nothing is consumed and nothing can be: the key is wrapped to one machine's identity.
    return renderLocked(receipt, lockedTicketLink(location.origin, reading.locked), context);
  }
  if (reading.kind === "unsupported_version") {
    context.finish();
    return renderMessage(receipt, context, {
      title: "CAN'T READ THIS",
      body: "This stub uses a format this page doesn't know. Ask the sender for a new one.",
    });
  }

  showReceipt(
    receipt,
    { sections: [[h("p", { class: "checking", role: "status" }, "CHECKING TICKET…")]] },
    context.announce,
  );

  const outcome = await inspectTicket(reading.capability, context.transport);
  switch (outcome.kind) {
    case "sealed":
      return renderSealed(receipt, reading.capability, outcome.expiresAt, context);
    case "void":
      return renderVoid(receipt, context);
    case "unsupported_browser":
      return renderMessage(receipt, context, {
        title: "CAN'T OPEN HERE",
        body: "This browser can't decrypt it. Try a current Chrome, Firefox, or Safari.",
      });
    case "failed":
      return renderMessage(receipt, context, {
        title: outcome.reason === "rate_limited" ? "SLOW DOWN" : "NO CONNECTION",
        body:
          outcome.reason === "rate_limited"
            ? "Too many tries from your network. Nothing was used. Wait a minute and try again."
            : "Couldn't reach the server. Nothing was used. Try again.",
        retry: () => renderReveal(receipt, reading, context),
      });
  }
}

function renderSealed(
  receipt: HTMLElement,
  capability: TicketCapability,
  expiresAt: number,
  context: RevealContext,
) {
  const tear = h("button", { type: "button", class: "print" }, "TEAR TO REVEAL");
  const error = h("p", { class: "error", role: "alert" });
  const stub = h(
    "div",
    { class: "stub" },
    perforation("TEAR HERE"),
    h(
      "p",
      { class: "fine" },
      "It opens once. Tearing it voids the link, so be ready to copy what's inside.",
    ),
    pullHint(ticketLink(location.origin, capability), context.announce),
    tear,
    error,
  );

  tear.addEventListener("click", async () => {
    tear.disabled = true;
    tear.textContent = "TEARING…";
    error.textContent = "";

    const outcome = await revealTicket(capability, context.transport);
    switch (outcome.kind) {
      case "opened":
        context.finish();
        await tearStub(receipt, stub);
        return renderOpened(receipt, outcome.plaintext, context);
      case "void":
        return renderVoid(receipt, context);
      case "tampered":
        context.finish();
        return renderMessage(receipt, context, {
          title: "WON'T DECRYPT",
          body: "It opened, but the contents don't match this link. It's void now. Ask the sender for a new one.",
          stamped: true,
        });
      case "failed":
      case "uncertain":
        tear.disabled = false;
        tear.textContent = "TEAR TO REVEAL";
        error.textContent =
          outcome.kind === "uncertain"
            ? "The connection dropped mid-tear. Try again; if it did open, it'll show as void."
            : outcome.reason === "rate_limited"
              ? "Too many tries from your network. Nothing was used. Wait a minute, then tear again."
              : "Something went wrong on our side. Nothing was used. Try again.";
        return;
    }
  });

  showReceipt(
    receipt,
    {
      sections: [
        [
          h("p", { class: "admit" }, "ADMIT ONE"),
          h("p", { class: "ticket-facts" }, `VALID UNTIL ${formatStamp(expiresAt)}`),
          h(
            "p",
            { class: "lede" },
            "Someone sent you .env values. Only this link can open them.",
          ),
        ],
      ],
      message: "Ticket found. It can be opened once.",
    },
    context.announce,
  );
  attachStub(receipt, stub);
}

const PULL_COMMAND = `${NPX_STUBS} pull`;

/** The CLI command for this exact ticket, with a copy button, so it can go straight to an agent. */
function pullHint(link: string, announce: Announce, lead = "Pulling it into a project? ") {
  const command = `${PULL_COMMAND} ${link}`;
  // The page already took the key out of the address bar; don't put it back on screen.
  const shown = `${PULL_COMMAND} <this link>`;
  return h(
    "p",
    { class: "fine" },
    lead,
    h(
      "span",
      { class: "command" },
      h("code", {}, shown),
      copyButton({
        label: "COPY",
        className: "copy",
        ariaLabel: "Copy the pull command",
        text: () => command,
        announce,
        copiedMessage: "Command copied.",
      }),
    ),
  );
}

export function openedLabels(pairCount: number) {
  const plainText = pairCount === 0;
  return {
    copy: plainText ? "COPY" : "COPY ALL AS .ENV",
    copied: plainText ? "Copied." : "All values copied in .env format.",
    download: plainText ? "DOWNLOAD" : "DOWNLOAD .ENV",
    filename: plainText ? "stub.txt" : ".env",
    message: `Ticket opened. ${plainText ? "Text is ready to copy." : `${pairCount} ${pairCount === 1 ? "value" : "values"} ready to copy.`} The link is now void.`,
  };
}

function renderOpened(receipt: HTMLElement, plaintext: string, context: RevealContext) {
  const { announce } = context;
  // Ask before leaving the only copy, but only while this page is live: once it's hidden the
  // user has already left, and a restored copy must be able to redirect without a prompt.
  const leaving = new AbortController();
  window.addEventListener("beforeunload", (event) => event.preventDefault(), { signal: leaving.signal });
  window.addEventListener("pagehide", () => leaving.abort(), { once: true });

  const lines = parseDotenv(plaintext);
  const pairs = pairsOf(lines);
  const unreadable = lines.length - pairs.length;
  const labels = openedLabels(pairs.length);

  const list = h(
    "ol",
    { class: "secrets", "aria-label": "Environment variables" },
    ...pairs.map((pair) =>
      h(
        "li",
        { class: "secret" },
        h(
          "div",
          { class: "secret-head" },
          h("span", { class: "key" }, pair.key),
          copyButton({
            label: "COPY",
            className: "copy",
            ariaLabel: `Copy value of ${pair.key}`,
            text: () => pair.value,
            announce,
            copiedMessage: `${pair.key} copied.`,
          }),
        ),
        h("code", { class: "value" }, pair.value === "" ? "(empty)" : pair.value),
      ),
    ),
  );

  const copyAll = copyButton({
    label: labels.copy,
    className: "print",
    text: () => plaintext,
    announce,
    copiedMessage: labels.copied,
  });

  const download = h("button", { type: "button", class: "text-button" }, labels.download);
  download.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([plaintext], { type: "text/plain" }));
    h("a", { href: url, download: labels.filename }).click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  showReceipt(
    receipt,
    {
      stamped: true,
      sections: [
        [
          h("p", { class: "ticket-facts" }, `OPENED ${formatStamp(Date.now())}`),
          h(
            "p",
            { class: "lede" },
            "This is the only copy. The server deleted its own, and this page won't come back once you leave.",
          ),
        ],
        [
          h("div", { class: "unroll" }, pairs.length > 0 ? list : h("pre", { class: "raw" }, plaintext)),
          pairs.length > 0 &&
            unreadable > 0 &&
            h(
              "p",
              { class: "fine" },
              `${unreadable} ${unreadable === 1 ? "line wasn't" : "lines weren't"} KEY=VALUE. ` +
                "Copy all includes them exactly as sent.",
            ),
          pairs.length > 0 &&
            h(
              "p",
              { class: "fine" },
              "Next time, skip the copying: ",
              h("code", {}, `${PULL_COMMAND} <link>`),
              ".",
            ),
        ],
        [copyAll, download],
      ],
      message: labels.message,
      focus: copyAll,
    },
    announce,
  );
}

function renderLocked(receipt: HTMLElement, link: string, context: RevealContext) {
  showReceipt(
    receipt,
    {
      sections: [
        [
          h("p", { class: "admit" }, "LOCKED STUB"),
          h(
            "p",
            { class: "lede" },
            "Locked to one machine. A browser can't open it. On that machine, run:",
          ),
          pullHint(link, context.announce, ""),
        ],
        [h("a", { class: "text-button", href: "/" }, "PRINT YOUR OWN")],
      ],
      feed: true,
      message: "This stub is locked to one machine. Open it there with the stubs command line.",
    },
    context.announce,
  );
}

function renderVoid(receipt: HTMLElement, context: RevealContext) {
  context.finish();
  renderMessage(receipt, context, {
    title: "NOTHING HERE",
    body:
      "Already opened, or expired. Either way it's gone. Ask the sender for a new one.",
    stamped: true,
    message: "This ticket is void.",
  });
}

function renderMessage(
  receipt: HTMLElement,
  context: RevealContext,
  message: { title: string; body: string; stamped?: boolean; retry?: () => void; message?: string },
) {
  let retry: HTMLButtonElement | undefined;
  if (message.retry) {
    retry = h("button", { type: "button", class: "print" }, "TRY AGAIN");
    retry.addEventListener("click", message.retry);
  }

  showReceipt(
    receipt,
    {
      stamped: message.stamped,
      sections: [
        [h("p", { class: "admit" }, message.title), h("p", { class: "lede" }, message.body)],
        [retry, h("a", { class: "text-button", href: "/" }, "PRINT YOUR OWN")],
      ],
      feed: true,
      message: message.message ?? `${message.title}. ${message.body}`,
    },
    context.announce,
  );
}
