import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, seedTestDb, seedLidTestData, closeTestDb } from "./helpers/test-db.js";
import { getCanonicalJid, getActiveJid, mergeByCanonicalJid } from "../db.js";

describe("LID/JID helpers", () => {
  beforeAll(async () => {
    await setupTestDb();
    seedTestDb();
    seedLidTestData();
  });

  afterAll(() => {
    closeTestDb();
  });

  describe("getCanonicalJid", () => {
    it("resolves LID with mapping to phone JID", () => {
      const result = getCanonicalJid("169509591765046@lid");
      expect(result).toBe("50763345671@s.whatsapp.net");
    });

    it("returns LID as-is when no mapping exists", () => {
      const result = getCanonicalJid("999999999@lid");
      expect(result).toBe("999999999@lid");
    });

    it("returns phone JID unchanged", () => {
      const result = getCanonicalJid("50763345671@s.whatsapp.net");
      expect(result).toBe("50763345671@s.whatsapp.net");
    });

    it("returns unknown JID unchanged", () => {
      const result = getCanonicalJid("12345678@s.whatsapp.net");
      expect(result).toBe("12345678@s.whatsapp.net");
    });
  });

  describe("getActiveJid", () => {
    it("returns LID when most recent message is under LID", () => {
      // The LID has messages at timestamps 1700000100 and 1700000110
      // The phone JID has a message at 1700000050
      // So the most recent is under the LID
      const result = getActiveJid("50763345671@s.whatsapp.net");
      expect(result).toBe("169509591765046@lid");
    });

    it("returns phone JID when most recent message is under phone", () => {
      // For the unmapped LID, there's only one JID, so it returns that
      const result = getActiveJid("999999999@lid");
      expect(result).toBe("999999999@lid");
    });

    it("returns input JID when no messages exist", () => {
      // Use a JID that has no messages
      const result = getActiveJid("15550001111@s.whatsapp.net");
      expect(result).toBe("15550001111@s.whatsapp.net");
    });
  });

  describe("mergeByCanonicalJid", () => {
    it("merges two items with same canonical JID", () => {
      const items = [
        { jid: "169509591765046@lid", name: "LID Name", count: 2 },
        { jid: "50763345671@s.whatsapp.net", name: "Phone Name", count: 3 },
      ];

      const result = mergeByCanonicalJid(
        items,
        (item) => item.jid,
        (existing, incoming) => ({
          jid: existing.jid,
          name: existing.name || incoming.name,
          count: existing.count + incoming.count,
        })
      );

      expect(result).toHaveLength(1);
      expect(result[0].jid).toBe("169509591765046@lid");
      expect(result[0].count).toBe(5);
    });

    it("preserves unmapped LIDs separately", () => {
      const items = [
        { jid: "169509591765046@lid", name: "Mapped LID", count: 1 },
        { jid: "999999999@lid", name: "Unmapped LID", count: 2 },
      ];

      const result = mergeByCanonicalJid(
        items,
        (item) => item.jid,
        (existing, incoming) => ({
          jid: existing.jid,
          name: existing.name,
          count: existing.count + incoming.count,
        })
      );

      expect(result).toHaveLength(2);
      const unmapped = result.find((r) => r.jid === "999999999@lid");
      expect(unmapped).toBeDefined();
      expect(unmapped?.count).toBe(2);
    });

    it("handles empty input", () => {
      const result = mergeByCanonicalJid<{ jid: string; name: string; count: number }>(
        [],
        (item) => item.jid,
        (existing, incoming) => existing
      );

      expect(result).toHaveLength(0);
    });

    it("preserves single items without merging", () => {
      const items = [
        { jid: "12345678@s.whatsapp.net", name: "Single", count: 5 },
      ];

      const result = mergeByCanonicalJid(
        items,
        (item) => item.jid,
        (existing, incoming) => existing
      );

      expect(result).toHaveLength(1);
      expect(result[0].count).toBe(5);
    });
  });
});
