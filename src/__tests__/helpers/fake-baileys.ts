import { EventEmitter } from "node:events";

type ConnectionUpdate = {
  connection: "open" | "close";
  lastDisconnect?: { error?: { output?: { statusCode?: number } } };
  qr?: string;
};

class FakeSocketEvents extends EventEmitter {
  process(handler: (events: Record<string, unknown>) => void | Promise<void>): void {
    this.on("event", handler);
  }

  emitBatch(events: Record<string, unknown>): void {
    this.emit("event", events);
  }
}

export class FakeBaileysSocket {
  readonly ev = new FakeSocketEvents();
  readonly sentMessages: Array<{ jid: string; content: Record<string, unknown> }> = [];
  readonly presenceUpdates: Array<{ presence: string; jid?: string }> = [];

  user = {
    id: "15559990000@s.whatsapp.net",
    name: "Test User",
    lid: "15559990000@lid",
  };

  async sendMessage(jid: string, content: Record<string, unknown>): Promise<{ key: { id: string } }> {
    this.sentMessages.push({ jid, content });
    return { key: { id: `fake-msg-${this.sentMessages.length}` } };
  }

  async sendPresenceUpdate(presence: string, jid?: string): Promise<void> {
    this.presenceUpdates.push({ presence, jid });
  }

  async chatModify(): Promise<void> {
    return undefined;
  }

  async groupMetadata(jid: string): Promise<{ subject: string }> {
    return { subject: `Group ${jid}` };
  }

  async updateMediaMessage(): Promise<void> {
    return undefined;
  }

  end(): void {
    this.ev.removeAllListeners();
  }

  emitConnection(update: ConnectionUpdate): void {
    this.ev.emitBatch({ "connection.update": update });
  }

  emitConnectionOpen(): void {
    this.emitConnection({ connection: "open" });
  }

  emitConnectionClose(statusCode = 500): void {
    this.emitConnection({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode } } },
    });
  }

  emitMessagesUpsert(messages: unknown[]): void {
    this.ev.emitBatch({ "messages.upsert": { messages, type: "notify" } });
  }

  emitCredsUpdate(payload: Record<string, unknown> = {}): void {
    this.ev.emit("creds.update", payload);
  }
}

export function createFakeBaileysSocket(): FakeBaileysSocket {
  return new FakeBaileysSocket();
}
