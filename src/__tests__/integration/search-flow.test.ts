import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, seedTestDb, setupTestDb } from "../helpers/test-db.js";
import { createMcpTestClient, type McpTestClient } from "../helpers/mcp-test-client.js";

describe("integration: search and listing flow", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    await setupTestDb();
    seedTestDb();

    const { getDb } = await import("../../db.js");
    const db = getDb();
    db.prepare("INSERT INTO contacts (jid, name, notify) VALUES (?, ?, ?)").run(
      "15550002222@s.whatsapp.net",
      "Bob Search",
      "Bob"
    );
    db.prepare("INSERT INTO contacts (jid, name, notify) VALUES (?, ?, ?)").run(
      "15550003333@s.whatsapp.net",
      "Charlie Search",
      "Charlie"
    );

    db.prepare("INSERT INTO chats (jid, name, conversation_ts, unread_count) VALUES (?, ?, ?, ?)").run(
      "15550002222@s.whatsapp.net",
      "Bob Search",
      1700000010,
      1
    );
    db.prepare("INSERT INTO chats (jid, name, conversation_ts, unread_count) VALUES (?, ?, ?, ?)").run(
      "15550003333@s.whatsapp.net",
      "Charlie Search",
      1700000020,
      0
    );

    db.prepare(
      "INSERT INTO messages (id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media, message_blob, transcription) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "search-msg-1",
      "15550002222@s.whatsapp.net",
      0,
      "15550002222@s.whatsapp.net",
      "Bob Search",
      "text",
      "Need coffee beans and filters",
      1700000010,
      0,
      null,
      null
    );
    db.prepare(
      "INSERT INTO messages (id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media, message_blob, transcription) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "search-msg-2",
      "15550003333@s.whatsapp.net",
      0,
      "15550003333@s.whatsapp.net",
      "Charlie Search",
      "text",
      "Coffee meeting tomorrow",
      1700000020,
      0,
      null,
      null
    );

    client = await createMcpTestClient();
  });

  afterAll(async () => {
    await client?.close();
    closeTestDb();
  });

  it("searches messages and contacts, and honors list_chats limit", async () => {
    const messageResults = (await client.callTool("search_messages", {
      query: "coffee",
    })) as any[];
    expect(messageResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "search-msg-1" }),
        expect.objectContaining({ id: "search-msg-2" }),
      ])
    );

    const contactResults = (await client.callTool("search_contacts", {
      query: "Search",
    })) as any[];
    expect(contactResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jid: "15550002222@s.whatsapp.net", name: "Bob Search" }),
        expect.objectContaining({ jid: "15550003333@s.whatsapp.net", name: "Charlie Search" }),
      ])
    );

    const chats = (await client.callTool("list_chats", { limit: 2 })) as any[];
    expect(chats).toHaveLength(2);
    expect(chats[0]).toMatchObject({ jid: "15550003333@s.whatsapp.net" });
    expect(chats[1]).toMatchObject({ jid: "15550002222@s.whatsapp.net" });
  });
});
