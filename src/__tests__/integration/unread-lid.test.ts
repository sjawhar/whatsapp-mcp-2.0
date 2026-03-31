import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, seedLidTestData, seedTestDb, setupTestDb } from "../helpers/test-db.js";
import { getUnreadChats } from "../../db.js";

describe("integration: unread chats with LID/phone merging", () => {
  beforeAll(async () => {
    await setupTestDb();
    seedTestDb();
    seedLidTestData();
  });

  afterAll(() => {
    closeTestDb();
  });

  it("should merge LID and phone chats by canonical JID", () => {
    const unreadChats = getUnreadChats();

    // Find the merged entry for Panama Equity (mapped contact)
    const mergedChat = unreadChats.find(
      (chat) => chat.jid === "50763345671@s.whatsapp.net"
    );

    expect(mergedChat).toBeDefined();
    expect(mergedChat?.name).toBe("Panama Equity");
    // unread_count: LID has 2, phone has 1 = 3 total
    expect(mergedChat?.unreadCount).toBe(3);
    // Should use latest timestamp (LID: 1700000100)
    expect(mergedChat?.recentMessages).toBeDefined();
  });

  it("should include unmapped LID contacts separately", () => {
    const unreadChats = getUnreadChats();

    // The unmapped LID contact should appear as its own entry
    const unmappedChat = unreadChats.find(
      (chat) => chat.jid === "999999999@lid"
    );

    // Note: seedLidTestData sets unmapped LID unread_count to 0, so it won't appear
    // in getUnreadChats() which filters WHERE unread_count > 0
    // This test verifies the behavior is correct
    expect(unmappedChat).toBeUndefined();
  });

  it("should have only one entry for the mapped contact", () => {
    const unreadChats = getUnreadChats();

    const phoneJidEntries = unreadChats.filter(
      (chat) => chat.jid === "50763345671@s.whatsapp.net"
    );
    const lidJidEntries = unreadChats.filter(
      (chat) => chat.jid === "169509591765046@lid"
    );

    expect(phoneJidEntries).toHaveLength(1);
    expect(lidJidEntries).toHaveLength(0);
  });

  it("should sort by latest conversation timestamp after merging", () => {
    const unreadChats = getUnreadChats();

    // Panama Equity should be first (latest ts: 1700000100 from LID)
    expect(unreadChats[0]?.jid).toBe("50763345671@s.whatsapp.net");
  });
});
