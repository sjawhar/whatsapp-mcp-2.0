import { vi } from "vitest";

vi.mock("better-sqlite3", async () => {
  const actual = await vi.importActual<any>("better-sqlite3");
  const RealDatabase = (actual.default ?? actual) as new (path: string, options?: unknown) => any;

  class InMemoryDatabase extends RealDatabase {
    constructor(_path: string, options?: unknown) {
      super(":memory:", options);
    }
  }

  return { default: InMemoryDatabase };
});

let dbModule: typeof import("../../db.js") | null = null;

export async function setupTestDb(): Promise<void> {
  dbModule = await import("../../db.js");
  dbModule.initDb();
}

export function seedTestDb(): void {
  if (!dbModule) {
    throw new Error("setupTestDb() must be called first");
  }

  const db = dbModule.getDb();

  db.prepare("INSERT INTO contacts (jid, name, notify) VALUES (?, ?, ?)").run(
    "15550001111@s.whatsapp.net",
    "Alice Test",
    "Alice"
  );

  db.prepare("INSERT INTO chats (jid, name, conversation_ts, unread_count) VALUES (?, ?, ?, ?)").run(
    "15550001111@s.whatsapp.net",
    "Alice Test",
    1700000000,
    0
  );

  db.prepare(
    "INSERT INTO messages (id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media, message_blob, transcription) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    "seed-msg-1",
    "15550001111@s.whatsapp.net",
    0,
    "15550001111@s.whatsapp.net",
    "Alice Test",
    "text",
    "Hello from seeded test data",
    1700000000,
    0,
    null,
    null
  );
}

export function closeTestDb(): void {
  if (!dbModule) return;
  dbModule.closeDb();
  dbModule = null;
}
