import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, seedLidTestData, setupTestDb } from "./helpers/test-db.js";
import { createMcpTestClient, type McpTestClient } from "./helpers/mcp-test-client.js";
import fs from "fs";
import path from "path";

describe("REAL MANUAL QA: LID/JID Unification", () => {
  let client: McpTestClient;
  const evidenceDir = ".sisyphus/evidence/final-qa";

  beforeAll(async () => {
    process.env.MIN_SEND_INTERVAL_MS = "0";
    process.env.SEND_JITTER_MS = "0";

    await setupTestDb();
    seedLidTestData();

    client = await createMcpTestClient();
  });

  afterAll(async () => {
    await client?.close();
    closeTestDb();
  });

  function saveEvidence(filename: string, content: string): void {
    const filepath = path.join(evidenceDir, filename);
    fs.writeFileSync(filepath, content, "utf-8");
    console.log(`✓ Evidence saved: ${filepath}`);
  }

  // Test 1: get_unread_messages - should show merged view
  it("get_unread_messages returns merged view (one entry per contact)", async () => {
    const result = (await client.callTool("get_unread_messages", {
      messagesPerChat: 5,
    })) as any;

    const text = JSON.stringify(result, null, 2);
    saveEvidence("tool-get-unread-messages.txt", text);

    expect(result).toHaveProperty("totalChatsWithUnread");
    expect(result.chats).toBeDefined();

    // Should have Panama Equity (merged from LID + phone)
    const panamaChatCount = result.chats.filter((c: any) => c.name === "Panama Equity").length;
    expect(panamaChatCount).toBe(1);

    // Panama Equity should use canonical phone JID
    const panamaChat = result.chats.find((c: any) => c.name === "Panama Equity");
    expect(panamaChat?.jid).toBe("50763345671@s.whatsapp.net");
    expect(panamaChat?.unreadCount).toBe(3);
  });

  // Test 2: search_contacts - should return deduplicated results
  it("search_contacts returns deduplicated results", async () => {
    const result = (await client.callTool("search_contacts", { query: "Panama" })) as any[];

    const text = JSON.stringify(result, null, 2);
    saveEvidence("tool-search-contacts.txt", text);

    // Should have exactly one Panama Equity entry
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("Panama Equity");
    expect(result[0].jid).toBe("50763345671@s.whatsapp.net");
  });

  // Test 3: search_messages - should return canonical phone JID
  it("search_messages returns canonical phone JID in chat field", async () => {
    const result = (await client.callTool("search_messages", { query: "apartment" })) as any[];

    const text = JSON.stringify(result, null, 2);
    saveEvidence("tool-search-messages.txt", text);

    expect(result.length).toBeGreaterThan(0);
    const msg = result[0];
    expect(msg.chat).toBe("50763345671@s.whatsapp.net");
    expect(msg.text).toContain("apartment");
  });

  // Test 4: list_chats - should show merged chats
  it("list_chats shows merged chats (one entry per contact)", async () => {
    const result = (await client.callTool("list_chats", { limit: 20 })) as any[];

    const text = JSON.stringify(result, null, 2);
    saveEvidence("tool-list-chats.txt", text);

    // Should have Panama Equity (merged) and Unknown Broker (unmapped)
    const panamaChatCount = result.filter((c: any) => c.name === "Panama Equity").length;
    expect(panamaChatCount).toBe(1);

    // Panama Equity should use canonical phone JID
    const panamaChat = result.find((c: any) => c.name === "Panama Equity");
    expect(panamaChat?.jid).toBe("50763345671@s.whatsapp.net");
  });

  // Test 5: list_messages - should show messages from both threads
  it("list_messages shows messages from both JID threads", async () => {
    const result = (await client.callTool("list_messages", {
      jid: "50763345671@s.whatsapp.net",
      limit: 50,
    })) as any[];

    const text = JSON.stringify(result, null, 2);
    saveEvidence("tool-list-messages.txt", text);

    // Should have messages from both LID and phone JID threads
    expect(result.length).toBeGreaterThanOrEqual(3);

    const apartmentMsg = result.find((m: any) => m.text?.includes("apartment"));
    const depositMsg = result.find((m: any) => m.text?.includes("deposit"));
    const sendingMsg = result.find((m: any) => m.text?.includes("sending"));

    expect(apartmentMsg).toBeDefined();
    expect(depositMsg).toBeDefined();
    expect(sendingMsg).toBeDefined();
  });

  // Test 6: send_message preview - should show correct name and canonical JID
  it("send_message preview shows correct contact name and canonical JID", async () => {
    // Test with LID JID input
    const result = (await client.callTool("send_message", {
      jid: "169509591765046@lid",
      text: "Test message",
      confirmed: false,
    })) as any;

    const text = JSON.stringify(result, null, 2);
    saveEvidence("tool-send-message-preview.txt", text);

    // Should show canonical phone JID and correct name
    expect(text).toContain("50763345671@s.whatsapp.net");
    expect(text).toContain("Panama Equity");
  });

  // Test 7: Backward compatibility - phone JID input still works
  it("backward compatibility: phone JID input works without changes", async () => {
    const result = (await client.callTool("list_messages", {
      jid: "50763345671@s.whatsapp.net",
      limit: 10,
    })) as any[];

    expect(result.length).toBeGreaterThan(0);
  });

  // Test 8: Unmapped LID appears separately in list_chats
  it("unmapped LID contact appears separately with LID as jid", async () => {
    const result = (await client.callTool("list_chats", { limit: 20 })) as any[];

    const brokerChat = result.find((c: any) => c.name === "Unknown Broker");
    expect(brokerChat).toBeDefined();
    expect(brokerChat?.jid).toBe("999999999@lid");
  });
});
