import { DurableObject } from "cloudflare:workers";

export interface SecretRecord {
  ciphertext: string;
  iv: string;
  expiresAt: number;
}

const RECORD_KEY = "record";

export class SecretBox extends DurableObject<Env> {
  async create(record: SecretRecord): Promise<"created" | "exists"> {
    const existing = await this.ctx.storage.get<SecretRecord>(RECORD_KEY);

    if (existing && Date.now() < existing.expiresAt) {
      return "exists";
    }

    // Alarm first: if the put then fails, the alarm just fires on empty storage, whereas the
    // reverse order could leave ciphertext behind with nothing scheduled to delete it.
    await this.ctx.storage.setAlarm(record.expiresAt);
    await this.ctx.storage.put(RECORD_KEY, record);

    return "created";
  }

  async status(): Promise<{ expiresAt: number } | null> {
    const record = await this.ctx.storage.get<SecretRecord>(RECORD_KEY);

    if (!record) {
      return null;
    }

    if (Date.now() >= record.expiresAt) {
      await this.clear();
      return null;
    }

    return { expiresAt: record.expiresAt };
  }

  async claim(): Promise<{ ciphertext: string; iv: string } | null> {
    const record = await this.ctx.storage.get<SecretRecord>(RECORD_KEY);

    if (!record) {
      return null;
    }

    if (Date.now() >= record.expiresAt) {
      await this.clear();
      return null;
    }

    await this.clear();

    return { ciphertext: record.ciphertext, iv: record.iv };
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
}
