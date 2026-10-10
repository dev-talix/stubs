import { describe, expect, it } from "vitest";
import { openedLabels } from "../../src/client/reveal";
import { pairsOf, parseDotenv } from "../../src/core/dotenv";

describe("opened ticket labels", () => {
  it("offers plain-text copying and download when no pairs exist", () => {
    expect(openedLabels(pairsOf(parseDotenv("sk_live_abc123")).length)).toEqual({
      copy: "COPY",
      copied: "Copied.",
      download: "DOWNLOAD",
      filename: "stub.txt",
      message: "Ticket opened. Text is ready to copy. The link is now void.",
    });
  });

  it.each(["KEY=value", "KEY=value\nstray text"])("keeps .env actions for %j", (text) => {
    expect(openedLabels(pairsOf(parseDotenv(text)).length)).toEqual({
      copy: "COPY ALL AS .ENV",
      copied: "All values copied in .env format.",
      download: "DOWNLOAD .ENV",
      filename: ".env",
      message: "Ticket opened. 1 value ready to copy. The link is now void.",
    });
  });
});
