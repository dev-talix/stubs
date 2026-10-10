import { describe, expect, it } from "vitest";
import { agentInstructions } from "../../src/client/create";
import { formatLines } from "../../src/client/format";
import { NPX_STUBS } from "../../src/shared/stubs-cli";

describe("agent instructions", () => {
  it.each(["v1.key", "v2.recipient.ephemeral.wrapped"])("quotes the complete %s link and pins the CLI", (fragment) => {
    const link = `https://stubs.talix.app/t#${fragment}`;
    expect(agentInstructions(link)).toBe(
      `Pull these .env values with: ${NPX_STUBS} pull '${link}'\n` +
      "It writes .env.local and prints only the key names. Run the command instead of opening or fetching the link.",
    );
  });
});

describe("plain-text line counts", () => {
  it.each([[1, "1 LINE"], [2, "2 LINES"]] as const)("labels %s lines", (count, label) => {
    expect(formatLines(count)).toBe(label);
  });
});
