import { createSecret, type ApiFailure } from "./api";
import { deriveTicket, generateTicketKey, seal } from "./crypto";
import { copyText, flashLabel, formatStamp, h } from "./dom";
import { parseDotenv } from "./dotenv";
import { barcode, feed, perforation, receiptHead, rule } from "./receipt";
import { DEFAULT_TTL_SECONDS, MAX_PLAINTEXT_BYTES, TTL_OPTIONS } from "../shared/protocol";

const PLACEHOLDER = [
  "DATABASE_URL=postgres://app:hunter2@db.internal:5432/app",
  "STRIPE_SECRET_KEY=sk_live_51H...",
  "# comments and blank lines are fine",
].join("\n");

const FAILURE_COPY: Record<ApiFailure, string> = {
  rate_limited: "The printer is jammed. Too many tickets from you in the last minute. Try again shortly.",
  too_large: "Too long to print. The limit is 32 KB.",
  network: "Couldn't reach the printer. Check your connection and try again.",
  not_found: "Something went wrong printing that ticket. Try again.",
  server: "Something went wrong printing that ticket. Try again.",
};

const byteLength = (text: string) => new TextEncoder().encode(text).length;

export function renderCreate(receipt: HTMLElement, announce: (message: string) => void) {
  const input = h("textarea", {
    id: "env-input",
    class: "env-input",
    rows: "8",
    wrap: "off",
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "off",
    "aria-describedby": "env-size",
    placeholder: PLACEHOLDER,
  });
  const size = h("span", { id: "env-size", class: "size" });
  const items = h("ol", { class: "items", "aria-label": "Items on this ticket" });
  const itemCount = h("span", {});
  const error = h("p", { class: "error", role: "alert" });
  const print = h("button", { type: "submit", class: "print" }, "PRINT TICKET");

  const ttl = h(
    "fieldset",
    { class: "ttl" },
    h("legend", {}, "VALID FOR"),
    ...TTL_OPTIONS.map((option) =>
      h(
        "label",
        { class: "ttl-option" },
        h("input", {
          type: "radio",
          name: "ttl",
          value: String(option.seconds),
          checked: option.seconds === DEFAULT_TTL_SECONDS,
        }),
        h("span", { class: "box", "aria-hidden": "true" }),
        option.label.toUpperCase(),
      ),
    ),
  );

  const form = h(
    "form",
    { class: "create", novalidate: true },
    h(
      "div",
      { class: "field-head" },
      h("label", { for: "env-input" }, "PASTE YOUR .ENV"),
      size,
    ),
    input,
    rule(),
    h("p", { class: "section-label" }, "ITEMS"),
    items,
    rule(),
    ttl,
    rule(),
    h("p", { class: "totals" }, itemCount, h("span", {}, "OPENS ONCE")),
    print,
    error,
    h(
      "p",
      { class: "fine" },
      "Encrypted in this browser before it leaves. The key rides in the link after the #, " +
        "which never reaches our server. We hold the ciphertext until it's opened or it expires.",
    ),
  );

  function refresh() {
    const text = input.value;
    const bytes = byteLength(text);
    const lines = parseDotenv(text);
    const pairs = lines.filter((line) => line.kind === "pair").length;

    size.textContent = `${(bytes / 1024).toFixed(1)} / 32 KB`;
    size.classList.toggle("over", bytes > MAX_PLAINTEXT_BYTES);
    itemCount.textContent = `ITEMS ${pairs}`;

    items.replaceChildren(
      ...(lines.length === 0
        ? [h("li", { class: "empty" }, "Nothing to print yet.")]
        : lines.map((line) =>
            line.kind === "pair"
              ? h(
                  "li",
                  { class: "item" },
                  h("span", { class: "key" }, line.key),
                  h("span", { class: "leader", "aria-hidden": "true" }),
                  h("span", { class: "mask" }, line.value === "" ? "EMPTY" : "••••••••"),
                )
              : h(
                  "li",
                  { class: "item invalid" },
                  h("span", { class: "key" }, `LINE ${line.line}`),
                  h("span", { class: "leader", "aria-hidden": "true" }),
                  h("span", { class: "mask" }, "CAN'T READ"),
                ),
          )),
    );
    print.disabled = text.trim() === "" || bytes > MAX_PLAINTEXT_BYTES;
  }

  input.addEventListener("input", () => {
    error.textContent = "";
    refresh();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (print.disabled) return;
    const text = input.value;
    const ttlSeconds = Number(new FormData(form).get("ttl") ?? DEFAULT_TTL_SECONDS);

    print.disabled = true;
    print.textContent = "PRINTING…";
    error.textContent = "";

    const key = generateTicketKey();
    let result: Awaited<ReturnType<typeof createSecret>>;
    try {
      const ticket = await deriveTicket(key);
      const sealed = await seal(text, ticket);
      result = await createSecret({ id: ticket.id, ...sealed, ttlSeconds });
    } catch {
      result = { ok: false, failure: "server" };
    }

    if (!result.ok) {
      print.textContent = "PRINT TICKET";
      print.disabled = false;
      error.textContent = FAILURE_COPY[result.failure];
      return;
    }

    const link = `${location.origin}/t#${key}`;
    const count = parseDotenv(text).filter((line) => line.kind === "pair").length;
    renderTicket(receipt, link, count, result.data.expiresAt, announce);
  });

  refresh();
  receipt.replaceChildren(receiptHead("ENV TICKET"), rule(), form);
}

function renderTicket(
  receipt: HTMLElement,
  link: string,
  count: number,
  expiresAt: number,
  announce: (message: string) => void,
) {
  const linkField = h("input", {
    class: "link",
    type: "text",
    readonly: true,
    value: link,
    "aria-label": "One-time link",
    spellcheck: "false",
  });
  linkField.addEventListener("focus", () => linkField.select());

  const copy = h("button", { type: "button", class: "print" }, "COPY LINK");
  copy.addEventListener("click", async () => {
    if (await copyText(link)) {
      flashLabel(copy, "COPIED");
      announce("Link copied.");
    } else {
      linkField.focus();
      announce("Couldn't copy automatically. The link is selected; copy it by hand.");
    }
  });

  const another = h("button", { type: "button", class: "text-button" }, "PRINT ANOTHER");
  another.addEventListener("click", () => {
    renderCreate(receipt, announce);
    feed(receipt);
    receipt.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  });

  receipt.replaceChildren(
    receiptHead("ENV TICKET"),
    rule(),
    h("p", { class: "admit" }, "ADMIT ONE"),
    h(
      "p",
      { class: "ticket-facts" },
      `${count} ${count === 1 ? "ITEM" : "ITEMS"} · VALID UNTIL ${formatStamp(expiresAt)}`,
    ),
    rule(),
    linkField,
    copy,
    h(
      "p",
      { class: "fine" },
      "Send this to one person. It opens once, then it's void. " +
        "Close this page and the link is gone for good, so copy it first.",
    ),
    perforation("KEEP THIS STUB"),
    barcode(),
    another,
  );
  feed(receipt);
  announce("Ticket printed. Copy the link and send it.");
  copy.focus();
}
