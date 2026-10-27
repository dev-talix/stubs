import { copyButton, selectText } from "./copy";
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
  focusHeading = false,
) {
  if (reading.kind === "malformed") {
    context.finish();
    return renderMessage(receipt, context, {
      title: "INCOMPLETE LINK",
      body: "The key after the # is cut short. Ask the sender for the whole link.",
    }, focusHeading);
  }
  if (reading.kind === "locked") {
    // Nothing is consumed and nothing can be: the key is wrapped to the recipient's identity key.
    return renderLocked(receipt, lockedTicketLink(location.origin, reading.locked), context);
  }
  if (reading.kind === "unsupported_version") {
    context.finish();
    return renderMessage(receipt, context, {
      title: "CAN'T READ THIS",
      body: "This stub uses a format this page doesn't know. Ask the sender for a new one.",
    }, focusHeading);
  }

  showReceipt(
    receipt,
    {
      sections: [[h("h2", { class: "checking", "aria-live": "polite" }, "CHECKING TICKET…")]],
      focusHeading,
    },
    context.announce,
  );

  const outcome = await inspectTicket(reading.capability, context.transport);
  switch (outcome.kind) {
    case "sealed":
      return renderSealed(receipt, reading.capability, outcome.expiresAt, context, focusHeading);
    case "void":
      return renderVoid(receipt, context, focusHeading);
    case "unsupported_browser":
      return renderMessage(receipt, context, {
        title: "CAN'T OPEN HERE",
        body: "This browser can't decrypt it. Try a current Chrome, Firefox, or Safari.",
      }, focusHeading);
    case "failed":
      return renderMessage(receipt, context, {
        title: outcome.reason === "rate_limited" ? "SLOW DOWN" : "NO CONNECTION",
        body:
          outcome.reason === "rate_limited"
            ? "Too many tries from your network. Nothing was used. Wait a minute and try again."
            : "Couldn't reach the server. Nothing was used. Try again.",
        retry: () => renderReveal(receipt, reading, context, true),
      }, focusHeading);
  }
}

function renderSealed(
  receipt: HTMLElement,
  capability: TicketCapability,
  expiresAt: number,
  context: RevealContext,
  focusHeading = false,
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
        return renderVoid(receipt, context, true);
      case "tampered":
        context.finish();
        return renderMessage(receipt, context, {
          title: "WON'T DECRYPT",
          body: "It opened, but the contents don't match this link. It's void now. Ask the sender for a new one.",
          stamped: true,
        }, true);
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
          h("h2", { class: "admit" }, "ADMIT ONE"),
          h("p", { class: "ticket-facts" }, `VALID UNTIL ${formatStamp(expiresAt)}`),
          h(
            "p",
            { class: "lede" },
            "Someone sent you .env values. Only this link can open them.",
          ),
        ],
      ],
      message: "Ticket found. It can be opened once.",
      focusHeading,
    },
    context.announce,
  );
  attachStub(receipt, stub);
}

const PULL_COMMAND = `${NPX_STUBS} pull`;

/** The CLI command for this exact ticket, with a copy button, so it can go straight to an agent. */
function pullHint(link: string, announce: Announce, lead = "Pulling it into a project? ") {
  const command = `${PULL_COMMAND} ${link}`;
  // Keep the key off screen unless manual copying is needed.
  const shown = `${PULL_COMMAND} <this link>`;
  const text = h("code", {}, shown);
  return h(
    "p",
    { class: "fine" },
    lead,
    h(
      "span",
      { class: "command" },
      text,
      copyButton({
        label: "COPY",
        className: "copy",
        ariaLabel: "Copy the pull command",
        text: () => command,
        announce,
        copiedMessage: "Command copied.",
        onRefused: () => {
          text.textContent = command;
          selectText(text);
          announce("Copy blocked. The command is selected. Press Ctrl+C or Cmd+C.");
        },
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
  // Ask before leaving the revealed values, but only while this page is live: once it's hidden the
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
    ...pairs.map((pair) => {
      const value = h("code", { class: "value" }, pair.value === "" ? "(empty)" : pair.value);
      return h(
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
            onRefused: () => {
              value.textContent = pair.value;
              selectText(value);
              announce("Copy blocked. The value is selected. Press Ctrl+C or Cmd+C.");
            },
          }),
        ),
        value,
      );
    }),
  );

  const raw = h("pre", { class: "raw" }, plaintext);
  const unroll = h("div", { class: "unroll" }, pairs.length > 0 ? list : raw);
  const copyAll = copyButton({
    label: labels.copy,
    className: "print",
    text: () => plaintext,
    announce,
    copiedMessage: labels.copied,
    onRefused: () => {
      unroll.replaceChildren(raw);
      selectText(raw);
      announce("Copy blocked. The text is selected. Press Ctrl+C or Cmd+C.");
    },
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
          h("h2", { class: "ticket-facts" }, `OPENED ${formatStamp(Date.now())}`),
          h(
            "p",
            { class: "lede" },
            "The server deleted its copy. Save what you need before leaving. This page won't come back.",
          ),
        ],
        [
          unroll,
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
      focusHeading: true,
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
          h("h2", { class: "admit" }, "LOCKED STUB"),
          h(
            "p",
            { class: "lede" },
            "Locked to a recipient's key. A browser can't open it. On the machine that holds the key, run:",
          ),
          pullHint(link, context.announce, ""),
        ],
        [h("a", { class: "text-button", href: "/" }, "PRINT YOUR OWN")],
      ],
      feed: true,
      message: "This stub is locked to a recipient's key. Use the stubs command line on that key's machine.",
    },
    context.announce,
  );
}

function renderVoid(receipt: HTMLElement, context: RevealContext, focusHeading = false) {
  context.finish();
  renderMessage(receipt, context, {
    title: "NOTHING HERE",
    body:
      "Already opened, or expired. Either way it's gone. Ask the sender for a new one.",
    stamped: true,
    message: "This ticket is void.",
  }, focusHeading);
}

function renderMessage(
  receipt: HTMLElement,
  context: RevealContext,
  message: { title: string; body: string; stamped?: boolean; retry?: () => void; message?: string },
  focusHeading = false,
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
        [h("h2", { class: "admit" }, message.title), h("p", { class: "lede" }, message.body)],
        [retry, h("a", { class: "text-button", href: "/" }, "PRINT YOUR OWN")],
      ],
      feed: true,
      message: message.message ?? `${message.title}. ${message.body}`,
      focusHeading,
    },
    context.announce,
  );
}
