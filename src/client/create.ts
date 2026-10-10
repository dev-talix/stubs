import { copyButton } from "./copy";
import {
  CreateFlow,
  assessDraft,
  isAcceptableRecipient,
  type CreateState,
  type FailureReason,
  type Issue,
} from "./create-flow";
import { h } from "./dom";
import { formatKilobytes, formatLines, formatStamp } from "./format";
import { barcode, perforation, showReceipt, type Announce } from "./receipt";
import { supportsLocking } from "../core/lock";
import { NPX_STUBS } from "../shared/stubs-cli";
import {
  DEFAULT_TTL_SECONDS,
  MAX_PLAINTEXT_BYTES,
  TTL_SECONDS,
  isTtlSeconds,
  type TtlSeconds,
} from "../shared/protocol";

const LIMIT = formatKilobytes(MAX_PLAINTEXT_BYTES);

export function agentInstructions(link: string): string {
  return (
    `Pull these .env values with: ${NPX_STUBS} pull '${link}'\n` +
    "It writes .env.local and prints only the key names. Run the command instead of opening or fetching the link."
  );
}

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

const LOCK_HINT =
  `Their stubs id, from \`${NPX_STUBS} id\`. ` +
  "A locked stub opens only on their machine, so the link is safe to share anywhere.";

const FAILURE_COPY: Record<FailureReason, string> = {
  empty: "There's nothing to print yet.",
  too_large: `Too long to print. The limit is ${LIMIT}.`,
  bad_recipient: "That stubs id can't receive a locked stub. Ask the recipient to run `stubs id` again.",
  rate_limited: "Printer jammed: too many tickets in the last minute. Try again shortly.",
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
  const textHint = h(
    "p",
    { class: "fine", hidden: true },
    "Opens as plain text in a browser. ", h("code", {}, "stubs pull"), " needs KEY=value.",
  );
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

  // Optional: lock the stub to one machine. Its owner runs `stubs id` and sends the result.
  const lockInput = h("input", {
    id: "lock-input",
    class: "lock-input",
    type: "text",
    placeholder: "stubs1…",
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "off",
    "aria-describedby": "lock-hint",
  });
  const lockHint = h("p", { id: "lock-hint", class: "fine" }, LOCK_HINT);
  const lock = h(
    "div",
    { class: "create lock" },
    h(
      "div",
      { class: "field-head" },
      h("label", { for: "lock-input" }, "LOCK TO A RECIPIENT"),
      h("span", { class: "size" }, "OPTIONAL"),
    ),
    lockInput,
    lockHint,
  );
  const recipient = () => lockInput.value.trim();
  void supportsLocking().then((supported) => {
    if (supported) return;
    lockInput.disabled = true;
    lockHint.textContent = "This browser can't lock stubs. Use a current Chrome, Firefox, or Safari.";
  });

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
    itemCount.textContent = draft.plainText ? formatLines(draft.lines.length) : `ITEMS ${draft.pairCount}`;
    textHint.hidden = !draft.plainText;
    items.replaceChildren(
      ...(draft.lines.length === 0
        ? [h("li", { class: "empty" }, "Nothing to print yet.")]
        : draft.lines.map((line) =>
            h(
              "li",
              { class: "item" },
              h("span", { class: "key" }, line.kind === "pair" ? line.key : `LINE ${line.line}`),
              h("span", { class: "leader", "aria-hidden": "true" }),
              h(
                "span",
                { class: "mask" },
                line.kind === "invalid" ? "TEXT" : line.value === "" ? "EMPTY" : "••••••••",
              ),
            ),
          )),
    );

    const badRecipient = !isAcceptableRecipient(recipient());
    lock.classList.toggle("invalid", badRecipient);
    lockHint.textContent = badRecipient ? "Not a stubs id. It starts with stubs1 and is 49 characters long." : LOCK_HINT;

    // While printing, the text is frozen: what's on screen is what gets printed.
    input.readOnly = printing;
    lockInput.readOnly = printing;
    print.disabled = !flow.canSubmit(input.value, recipient());
    print.textContent = printing ? "PRINTING…" : "PRINT TICKET";
    error.textContent = state.kind === "failed" ? FAILURE_COPY[state.reason] : "";
  }

  for (const control of [input, lockInput]) {
    control.addEventListener("input", () => {
      flow.edited();
      render(flow.state);
    });
  }

  print.addEventListener("click", () => {
    const choice = Number(ttl.querySelector<HTMLInputElement>("input[name=ttl]:checked")?.value);
    void flow.submit(input.value, isTtlSeconds(choice) ? choice : DEFAULT_TTL_SECONDS, recipient());
  });

  showReceipt(
    receipt,
    {
      sections: [
        [field],
        [h("p", { class: "section-label" }, "ITEMS"), items, textHint],
        [ttl],
        [lock],
        [
          h("p", { class: "totals" }, itemCount, h("span", {}, "OPENS ONCE")),
          print,
          error,
          h(
            "p",
            { class: "fine" },
            "Encrypted in your browser. The key travels in the link, after the #, and never reaches our server.",
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

  const instructions = h(
    "textarea",
    {
      class: "link",
      readonly: true,
      hidden: true,
      rows: "6",
      "aria-label": "Instructions for an agent",
    },
    agentInstructions(ticket.link),
  );
  instructions.addEventListener("focus", () => instructions.select());
  const copyAgent = copyButton({
    label: "COPY FOR AN AGENT",
    className: "text-button",
    text: () => agentInstructions(ticket.link),
    announce,
    copiedMessage: "Agent instructions copied.",
    onRefused: () => {
      instructions.hidden = false;
      instructions.focus();
      announce("Couldn't copy automatically. The instructions are selected; copy them by hand.");
    },
  });

  const another = h("button", { type: "button", class: "text-button" }, "PRINT ANOTHER");
  another.addEventListener("click", printAnother);

  const items = ticket.pairCount === 0 && ticket.lineCount > 0
    ? formatLines(ticket.lineCount)
    : `${ticket.pairCount} ${ticket.pairCount === 1 ? "ITEM" : "ITEMS"}`;
  const facts = `${items} · VALID UNTIL ${formatStamp(ticket.expiresAt)}${ticket.locked ? " · LOCKED" : ""}`;
  const sendHint = ticket.locked
    ? `Locked: only the recipient's machine can open it, with ${NPX_STUBS} pull. ` +
      "The link alone is harmless, so share it anywhere."
    : "Opens once, then it's void. Copy it now; it's gone when you leave this page.";
  showReceipt(
    receipt,
    {
      sections: [
        [
          h("p", { class: "admit" }, "ADMIT ONE"),
          h("p", { class: "ticket-facts" }, facts),
        ],
        [
          linkField,
          copy,
          copyAgent,
          instructions,
          h("p", { class: "fine" }, sendHint),
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
