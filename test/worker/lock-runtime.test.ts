import { describe, expect, it } from "vitest";
import { generateTicketKey } from "../../src/core/crypto";
import { generateIdentity, lockTicketKey, supportsLocking, unlockTicketKey } from "../../src/core/lock";

// Locked stubs are wrapped in browsers and unwrapped in Node, but the e2e tests exercise both
// halves inside workerd, so the runtime has to support X25519 too.
describe("locking in the Worker runtime", () => {
  it("round-trips a locked ticket key", async () => {
    expect(await supportsLocking()).toBe(true);
    const recipient = await generateIdentity();
    const key = generateTicketKey();
    expect(await unlockTicketKey(await lockTicketKey(key, recipient.publicId), recipient)).toBe(key);
  });
});
