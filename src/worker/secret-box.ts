import { DurableObject } from "cloudflare:workers";
import {
  parseTicketProof,
  type CreateTicketRequest,
  type CreateTicketResponse,
  type SealedTicket,
  type TicketStatus,
} from "../shared/protocol";

type StoredTicket = SealedTicket & { claimHash: string; expiresAt: number };
type TicketRecord = StoredTicket | { expiresAt: number };
const RECORD_KEY = "record";

export class SecretBox extends DurableObject<Env> {
  async store(ticket: Omit<CreateTicketRequest, "id">): Promise<CreateTicketResponse | "exists"> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.ctx.storage.get<TicketRecord>(RECORD_KEY);
      if (existing) {
        if (Date.now() < existing.expiresAt) return "exists";
        await this.clear();
      }

      const expiresAt = Date.now() + ticket.ttlSeconds * 1000;
      // Schedule cleanup first so a failed write cannot leave unscheduled ciphertext.
      await this.ctx.storage.setAlarm(expiresAt);
      await this.ctx.storage.put(RECORD_KEY, { ...ticket, expiresAt });
      return { expiresAt };
    });
  }

  async status(claimSecret: string): Promise<TicketStatus | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const record = await this.verifiedRecord(claimSecret);
      return record ? { expiresAt: record.expiresAt } : null;
    });
  }

  async claim(claimSecret: string): Promise<SealedTicket | null> {
    // Hashing yields outside storage's input gate. Hold the gate across verification and burn.
    return this.ctx.blockConcurrencyWhile(async () => {
      const record = await this.verifiedRecord(claimSecret);
      if (!record) return null;
      await this.ctx.storage.put(RECORD_KEY, { expiresAt: record.expiresAt });
      return { ciphertext: record.ciphertext, iv: record.iv };
    });
  }

  override async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const record = await this.ctx.storage.get<TicketRecord>(RECORD_KEY);
      // A delayed alarm for an older ticket must not delete its live replacement.
      if (record && Date.now() < record.expiresAt) {
        await this.ctx.storage.setAlarm(record.expiresAt);
        return;
      }
      await this.clear();
    });
  }

  private async verifiedRecord(claimSecret: string): Promise<StoredTicket | null> {
    if (!parseTicketProof({ claimSecret })) return null;
    const record = await this.ctx.storage.get<TicketRecord>(RECORD_KEY);
    if (!record || !("claimHash" in record)) return null;

    const digest = await crypto.subtle.digest("SHA-256", decodeBase64Url(claimSecret));
    const proofHash = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    if (!crypto.subtle.timingSafeEqual(decodeBase64Url(proofHash), decodeBase64Url(record.claimHash))) {
      return null;
    }
    if (Date.now() >= record.expiresAt) {
      await this.clear();
      return null;
    }
    return record;
  }

  private async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
}

function decodeBase64Url(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
    char.charCodeAt(0),
  );
}
