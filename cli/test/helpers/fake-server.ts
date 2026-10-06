// An in-memory server that follows the wire contract, copied from test/core/ticket.test.ts and
// extended with failure knobs. It serves both a transport function and a real HTTP listener.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { issueTicket, type Transport } from "../../../src/core/ticket";

type Reply = { status: number; body: unknown };
type Stored = { claimHash: string; ciphertext: string; iv: string };

export interface FakeServer {
  store: Map<string, Stored>;
  /** Every request path and body, in order. */
  sent: string[];
  /** Claims get no response (the connection drops) after the server has processed them. */
  dropClaims: boolean;
  /** Answer everything with 429. */
  rateLimited: boolean;
  /** Runs when a claim arrives, before it's answered. */
  onClaim: (() => Promise<void> | void) | null;
  transport: Transport;
  /** Seals `text` and returns its link for `origin`, locked when `lockTo` is a public id. */
  seed(text: string, origin: string, lockTo?: string): Promise<string>;
  /** Flips a byte of every stored ciphertext, so opening succeeds but decryption fails. */
  tamperAll(): void;
  listen(): Promise<{ origin: string; close: () => Promise<void> }>;
}

const hash = async (secret: string) => {
  const bytes = Uint8Array.from(atob(secret.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function fakeServer(): FakeServer {
  const server: FakeServer = {
    store: new Map(),
    sent: [],
    dropClaims: false,
    rateLimited: false,
    onClaim: null,
    transport: async (path, init) => {
      const reply = await handle(path, String(init.body));
      if (reply === "drop") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    },
    async seed(text, origin, lockTo) {
      const issued = await issueTicket(text, 3600, server.transport, origin, lockTo ? { lockTo } : {});
      if (issued.kind !== "issued") throw new Error(issued.reason);
      server.sent.length = 0;
      return issued.link;
    },
    tamperAll() {
      for (const record of server.store.values()) {
        record.ciphertext = (record.ciphertext[0] === "A" ? "B" : "A") + record.ciphertext.slice(1);
      }
    },
    listen: () => listen(handle),
  };

  async function handle(path: string, bodyText: string): Promise<Reply | "drop"> {
    server.sent.push(path, bodyText);
    if (server.rateLimited) return { status: 429, body: { error: "rate_limited" } };
    const body = JSON.parse(bodyText);
    if (path === "/api/tickets") {
      server.store.set(body.id, body);
      return { status: 201, body: { expiresAt: 4_102_444_800_000 } };
    }
    const [, id, action] = /^\/api\/tickets\/([^/]+)\/(status|claim)$/.exec(path) ?? [];
    const record = server.store.get(id ?? "");
    if (!record || record.claimHash !== (await hash(body.claimSecret))) {
      return { status: 404, body: { error: "not_found" } };
    }
    if (action === "status") return { status: 200, body: { expiresAt: 4_102_444_800_000 } };
    await server.onClaim?.();
    server.store.delete(id!);
    if (server.dropClaims) return "drop";
    return { status: 200, body: { ciphertext: record.ciphertext, iv: record.iv } };
  }

  return server;
}

function listen(handle: (path: string, body: string) => Promise<Reply | "drop">) {
  const http: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const reply = await handle(req.url ?? "", Buffer.concat(chunks).toString("utf8"));
    if (reply === "drop") {
      req.socket.destroy();
      return;
    }
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  return new Promise<{ origin: string; close: () => Promise<void> }>((resolve) => {
    http.listen(0, "127.0.0.1", () => {
      const { port } = http.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => http.close(() => done())),
      });
    });
  });
}
