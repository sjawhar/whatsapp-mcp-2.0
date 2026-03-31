import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, seedLidTestData, setupTestDb } from "../helpers/test-db.js";
import { createMcpTestClient, type McpTestClient } from "../helpers/mcp-test-client.js";

describe("integration: LID E2E workflow with unified identity", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    await setupTestDb();
    seedLidTestData();
    client = await createMcpTestClient();
  });

  afterAll(async () => {
    await client?.close();
    closeTestDb();
  });

  it("get_unread_messages returns merged view with one entry per contact", async () => {
    const result = (await client.callTool("get_unread_messages", {
      messagesPerChat: 5,
    })) as any;

    expect(result).toHaveProperty("totalChatsWithUnread");
    expect(result.chats).toBeDefined();

    // Panama Equity should appear once (merged from LID + phone)
    const panamaChats = result.chats.filter((chat: any) => chat.name === "Panama Equity");
    expect(panamaChats.length).toBe(1);
    expect(panamaChats[0].jid).toBe("50763345671@s.whatsapp.net"); // Phone JID (canonical)
  });

  it("search_contacts with 'Panama' returns single deduped result with phone JID", async () => {
    const result = (await client.callTool("search_contacts", {
      query: "Panama",
    })) as any[];

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);

    // Should have exactly one Panama Equity entry
    const panamaResults = result.filter((contact: any) => contact.name === "Panama Equity");
    expect(panamaResults.length).toBe(1);
    expect(panamaResults[0].jid).toBe("50763345671@s.whatsapp.net"); // Phone JID
  });

  it("search_messages with 'apartment' returns canonical phone JID in chat field", async () => {
    const result = (await client.callTool("search_messages", {
      query: "apartment",
    })) as any[];

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);

    // Should find the message from LID JID but return it with phone JID
    const apartmentMessages = result.filter((msg: any) => msg.text?.includes("apartment"));
    expect(apartmentMessages.length).toBeGreaterThan(0);

    // The chat field should be the canonical phone JID
    apartmentMessages.forEach((msg: any) => {
      expect(msg.chat).toBe("50763345671@s.whatsapp.net");
    });
  });

  it("list_chats returns merged chat entries", async () => {
    const result = (await client.callTool("list_chats", {
      limit: 20,
    })) as any[];

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);

    // Panama Equity should appear once
    const panamaChats = result.filter((chat: any) => chat.name === "Panama Equity");
    expect(panamaChats.length).toBe(1);
    expect(panamaChats[0].jid).toBe("50763345671@s.whatsapp.net"); // Phone JID
  });

  it("list_messages with phone JID returns messages from both threads", async () => {
    const result = (await client.callTool("list_messages", {
      jid: "50763345671@s.whatsapp.net",
      limit: 50,
    })) as any[];

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);

    // Should include messages from both LID and phone threads
    const messageTexts = result.map((msg: any) => msg.text);
    expect(messageTexts).toContain("Looking at the apartment tomorrow");
    expect(messageTexts).toContain("Can you send the deposit?");
    expect(messageTexts).toContain("Sure, sending now");
  });

  it("send_message with confirmed=false shows canonical phone JID in preview", async () => {
    const result = (await client.callTool("send_message", {
      jid: "50763345671@s.whatsapp.net",
      text: "Test message",
      confirmed: false,
    })) as any;

    expect(result).toHaveProperty("status", "confirmation_required");
    expect(result).toHaveProperty("jid", "50763345671@s.whatsapp.net"); // Canonical phone JID
    expect(result).toHaveProperty("to", "Panama Equity");
    expect(result).toHaveProperty("message", "Test message");
  });
});
