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

export function seedLidTestData(): void {
  if (!dbModule) {
    throw new Error("setupTestDb() must be called first");
  }

  const db = dbModule.getDb();

  // Create JID mapping: LID -> phone
  db.prepare("INSERT INTO jid_mapping (lid_jid, phone_jid) VALUES (?, ?)").run(
    "169509591765046@lid",
    "50763345671@s.whatsapp.net"
  );

  // Create contact entries for both JIDs (same contact, two identities)
  db.prepare("INSERT INTO contacts (jid, name, notify) VALUES (?, ?, ?)").run(
    "169509591765046@lid",
    "Panama Equity",
    "Panama Equity"
  );

  db.prepare("INSERT INTO contacts (jid, name, notify) VALUES (?, ?, ?)").run(
    "50763345671@s.whatsapp.net",
    "Panama Equity",
    "Panama Equity"
  );

  // Create chat entries for both JIDs
  db.prepare("INSERT INTO chats (jid, name, conversation_ts, unread_count) VALUES (?, ?, ?, ?)").run(
    "169509591765046@lid",
    "Panama Equity",
    1700000100,
    2
  );

  db.prepare("INSERT INTO chats (jid, name, conversation_ts, unread_count) VALUES (?, ?, ?, ?)").run(
    "50763345671@s.whatsapp.net",
    "Panama Equity",
    1700000050,
    1
  );

  // Messages under the LID JID (incoming)
  db.prepare(
    "INSERT INTO messages (id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media, message_blob, transcription) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    "lid-msg-1",
    "169509591765046@lid",
    0,
    "169509591765046@lid",
    "Panama Equity",
    "text",
    "Looking at the apartment tomorrow",
    1700000100,
    0,
    null,
    null
  );

  db.prepare(
    "INSERT INTO messages (id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media, message_blob, transcription) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    "lid-msg-2",
    "169509591765046@lid",
    0,
    "169509591765046@lid",
    "Panama Equity",
    "text",
    "Can you send the deposit?",
    1700000110,
    0,
    null,
    null
  );

  // Messages under the phone JID (outgoing)
  db.prepare(
    "INSERT INTO messages (id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media, message_blob, transcription) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    "phone-msg-1",
    "50763345671@s.whatsapp.net",
    1,
    "15559990000@s.whatsapp.net",
    "Me",
    "text",
    "Sure, sending now",
    1700000050,
    0,
    null,
    null
  );

  // Unmapped LID contact (no jid_mapping entry)
  db.prepare("INSERT INTO contacts (jid, name, notify) VALUES (?, ?, ?)").run(
    "999999999@lid",
    "Unknown Broker",
    "Unknown Broker"
  );

  db.prepare("INSERT INTO chats (jid, name, conversation_ts, unread_count) VALUES (?, ?, ?, ?)").run(
    "999999999@lid",
    "Unknown Broker",
    1700000000,
    0
  );

  db.prepare(
    "INSERT INTO messages (id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media, message_blob, transcription) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    "unmapped-msg-1",
    "999999999@lid",
    0,
    "999999999@lid",
    "Unknown Broker",
    "text",
    "Interested in the property?",
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
