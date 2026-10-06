import { copyButton } from "./copy";
import { CreateFlow, assessDraft, type CreateState, type FailureReason, type Issue } from "./create-flow";
import { h } from "./dom";
import { formatKilobytes, formatStamp } from "./format";
import { barcode, perforation, showReceipt, type Announce } from "./receipt";
import {
  DEFAULT_TTL_SECONDS,
  MAX_PLAINTEXT_BYTES,
  TTL_SECONDS,
  isTtlSeconds,
  type TtlSeconds,
} from "../shared/protocol";

const LIMIT = formatKilobytes(MAX_PLAINTEXT_BYTES);

const TTL_LABELS: Record<TtlSeconds, string> = {
  300: "5 MIN",
  3600: "1 HOUR",
  86400: "1 DAY",
  604800: "7 DAYS",
};

const PLACEHOLDER = [
  "DATABASE_URL=postgres://app:hunter2@db.internal:5432/app",
  "STRIPE_SECRET_KEY=sk_live_51H...",
  "# comments and blank lines are fine",
].join("\n");

const FAILURE_COPY: Record<FailureReason, string> = {
  empty: "There's nothing to print yet.",
  too_large: `Too long to print. The limit is ${LIMIT}.`,
  rate_limited: "The printer is jammed. Too many tickets from you in the last minute. Try again shortly.",
  network: "Couldn't reach the printer. Check your connection and try again.",
  server: "Something went wrong printing that ticket. Try again.",
};

export function renderCreate(receipt: HTMLElement, announce: Announce, issue: Issue) {
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
  const print = h("button", { type: "button", class: "print" }, "PRINT TICKET");

  const ttl = h(
    "fieldset",
    { class: "ttl" },
    h("legend", {}, "VALID FOR"),
    ...TTL_SECONDS.map((seconds) =>
      h(
        "label",
        { class: "ttl-option" },
        h("input", {
          type: "radio",
          name: "ttl",
          value: String(seconds),
          checked: seconds === DEFAULT_TTL_SECONDS,
        }),
        h("span", { class: "box", "aria-hidden": "true" }),
        TTL_LABELS[seconds],
      ),
    ),
  );

  const field = h(
    "div",
    { class: "create" },
    h("div", { class: "field-head" }, h("label", { for: "env-input" }, "PASTE YOUR .ENV"), size),
    input,
  );

  const flow = new CreateFlow(issue, (state) => render(state));

  function render(state: CreateState) {
    if (state.kind === "printed") {
      renderTicket(receipt, announce, state, () => {
        flow.reset();
        renderCreate(receipt, announce, issue);
      });
      return;
    }
    const draft = assessDraft(input.value);
    const printing = state.kind === "printing";

    size.textContent = `${formatKilobytes(draft.bytes)} / ${LIMIT}`;
    size.classList.toggle("over", draft.overLimit);
    itemCount.textContent = `ITEMS ${draft.pairCount}`;
    items.replaceChildren(
      ...(draft.lines.length === 0
        ? [h("li", { class: "empty" }, "Nothing to print yet.")]
        : draft.lines.map((line) =>
            h(
              "li",
              { class: line.kind === "pair" ? "item" : "item invalid" },
              h("span", { class: "key" }, line.kind === "pair" ? line.key : `LINE ${line.line}`),
              h("span", { class: "leader", "aria-hidden": "true" }),
              h(
                "span",
                { class: "mask" },
                line.kind === "invalid" ? "CAN'T READ" : line.value === "" ? "EMPTY" : "••••••••",
              ),
            ),
          )),
    );

    // While printing, the text is frozen: what's on screen is what gets printed.
    input.readOnly = printing;
    print.disabled = !flow.canSubmit(input.value);
    print.textContent = printing ? "PRINTING…" : "PRINT TICKET";
    error.textContent = state.kind === "failed" ? FAILURE_COPY[state.reason] : "";
  }

  input.addEventListener("input", () => {
    flow.edited();
    render(flow.state);
  });

  print.addEventListener("click", () => {
    const choice = Number(ttl.querySelector<HTMLInputElement>("input[name=ttl]:checked")?.value);
    void flow.submit(input.value, isTtlSeconds(choice) ? choice : DEFAULT_TTL_SECONDS);
  });

  showReceipt(
    receipt,
    {
      sections: [
        [field],
        [h("p", { class: "section-label" }, "ITEMS"), items],
        [ttl],
        [
          h("p", { class: "totals" }, itemCount, h("span", {}, "OPENS ONCE")),
          print,
          error,
          h(
            "p",
            { class: "fine" },
            "Encrypted in this browser before it leaves. The key rides in the link after the #, " +
              "which never reaches our server. We hold the ciphertext until it's opened or it expires.",
          ),
        ],
      ],
      feed: true,
    },
    announce,
  );
  render(flow.state);
}

function renderTicket(
  receipt: HTMLElement,
  announce: Announce,
  ticket: Extract<CreateState, { kind: "printed" }>,
  printAnother: () => void,
) {
  const linkField = h("input", {
    class: "link",
    type: "text",
    readonly: true,
    value: ticket.link,
    "aria-label": "One-time link",
    spellcheck: "false",
  });
  linkField.addEventListener("focus", () => linkField.select());

  const copy = copyButton({
    label: "COPY LINK",
    className: "print",
    text: () => ticket.link,
    announce,
    copiedMessage: "Link copied.",
    onRefused: () => {
      linkField.focus();
      announce("Couldn't copy automatically. The link is selected; copy it by hand.");
    },
  });

  const another = h("button", { type: "button", class: "text-button" }, "PRINT ANOTHER");
  another.addEventListener("click", printAnother);

  const items = `${ticket.pairCount} ${ticket.pairCount === 1 ? "ITEM" : "ITEMS"}`;
  showReceipt(
    receipt,
    {
      sections: [
        [
          h("p", { class: "admit" }, "ADMIT ONE"),
          h("p", { class: "ticket-facts" }, `${items} · VALID UNTIL ${formatStamp(ticket.expiresAt)}`),
        ],
        [
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
        ],
      ],
      feed: true,
      message: "Ticket printed. Copy the link and send it.",
      focus: copy,
    },
    announce,
  );
}
