import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, seedTestDb, seedLidTestData, closeTestDb } from "./helpers/test-db.js";
import {
  getMessageFromMe,
  getLastMessageKey,
  getAllJidsFor,
  deleteChatMessages,
  deleteChat,
  getDb,
} from "../db.js";

describe("LID-aware delete operations", () => {
  beforeAll(async () => {
    await setupTestDb();
    seedTestDb();
    seedLidTestData();
  });

  afterAll(() => {
    closeTestDb();
  });

  describe("getMessageFromMe — cross-JID lookup", () => {
    it("finds message stored under LID when queried by phone JID", () => {
      // lid-msg-1 is stored under 169509591765046@lid with from_me=0
      const result = getMessageFromMe("50763345671@s.whatsapp.net", "lid-msg-1");
      expect(result).not.toBeNull();
      expect(result!.fromMe).toBe(false);
      expect(result!.chatJid).toBe("169509591765046@lid");
    });

    it("finds message stored under phone JID when queried by LID", () => {
      // phone-msg-1 is stored under 50763345671@s.whatsapp.net with from_me=1
      const result = getMessageFromMe("169509591765046@lid", "phone-msg-1");
      expect(result).not.toBeNull();
      expect(result!.fromMe).toBe(true);
      expect(result!.chatJid).toBe("50763345671@s.whatsapp.net");
    });

    it("returns null for non-existent message", () => {
      const result = getMessageFromMe("50763345671@s.whatsapp.net", "does-not-exist");
      expect(result).toBeNull();
    });
  });

  describe("getLastMessageKey — cross-JID lookup", () => {
    it("finds most recent message across both JID variants", () => {
      // Most recent: lid-msg-2 at timestamp 1700000110 under LID
      const result = getLastMessageKey("50763345671@s.whatsapp.net");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("lid-msg-2");
      expect(result!.remoteJid).toBe("169509591765046@lid");
      expect(result!.timestamp).toBe(1700000110);
    });

    it("finds message when queried by LID directly", () => {
      const result = getLastMessageKey("169509591765046@lid");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("lid-msg-2");
    });
  });

  describe("deleteChat — both JID variants cleaned from local DB", () => {
    it("removes messages and chat entries for all JID variants", () => {
      const rawDb = getDb();

      // Verify data exists before deletion
      const msgsBefore = rawDb
        .prepare(
          "SELECT COUNT(*) as count FROM messages WHERE chat_jid IN (?, ?)"
        )
        .get("169509591765046@lid", "50763345671@s.whatsapp.net") as {
        count: number;
      };
      expect(msgsBefore.count).toBeGreaterThan(0);

      // Simulate what whatsapp.deleteChat should do: clean both variants
      const allJids = getAllJidsFor("169509591765046@lid");
      for (const jid of allJids) {
        deleteChatMessages(jid);
        deleteChat(jid);
      }

      // Verify messages deleted for both variants
      const msgsAfter = rawDb
        .prepare(
          "SELECT COUNT(*) as count FROM messages WHERE chat_jid IN (?, ?)"
        )
        .get("169509591765046@lid", "50763345671@s.whatsapp.net") as {
        count: number;
      };
      expect(msgsAfter.count).toBe(0);

      // Verify chat entries deleted for both variants
      const chatsAfter = rawDb
        .prepare(
          "SELECT COUNT(*) as count FROM chats WHERE jid IN (?, ?)"
        )
        .get("169509591765046@lid", "50763345671@s.whatsapp.net") as {
        count: number;
      };
      expect(chatsAfter.count).toBe(0);
    });
  });
});
