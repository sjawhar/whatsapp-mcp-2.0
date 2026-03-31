import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, seedLidTestData, setupTestDb } from "../helpers/test-db.js";
import { searchMessages, getRecentMessages } from "../../db.js";

describe("integration: searchMessages and getRecentMessages with LID canonicalization", () => {
  beforeAll(async () => {
    await setupTestDb();
    seedLidTestData();
  });

  afterAll(() => {
    closeTestDb();
  });

  it("searchMessages (global) should return canonical phone JID for LID messages", () => {
    const results = searchMessages("apartment") as Array<{ text?: string; chat: string }>;

    // Should find the message stored under LID JID
    expect(results.length).toBeGreaterThan(0);

    // The chat field should be canonicalized to phone JID, not LID
    const apartmentMsg = results.find((r) => r.text?.includes("apartment"));
    expect(apartmentMsg).toBeDefined();
    expect(apartmentMsg?.chat).toBe("50763345671@s.whatsapp.net");
    expect(apartmentMsg?.chat).not.toBe("169509591765046@lid");
  });

  it("searchMessages with specific JID should still work", () => {
    const results = searchMessages("apartment", "50763345671@s.whatsapp.net") as Array<{ text?: string; chat: string }>;

    // Should find the message when searching with phone JID
    expect(results.length).toBeGreaterThan(0);

    const apartmentMsg = results.find((r) => r.text?.includes("apartment"));
    expect(apartmentMsg).toBeDefined();
    expect(apartmentMsg?.chat).toBe("50763345671@s.whatsapp.net");
  });

  it("searchMessages with LID JID should also work via getAllJidsFor", () => {
    const results = searchMessages("apartment", "169509591765046@lid") as Array<{ text?: string; chat: string }>;

    // Should find the message when searching with LID JID
    expect(results.length).toBeGreaterThan(0);

    const apartmentMsg = results.find((r) => r.text?.includes("apartment"));
    expect(apartmentMsg).toBeDefined();
    // Result should still be canonicalized to phone JID
    expect(apartmentMsg?.chat).toBe("50763345671@s.whatsapp.net");
  });

  it("getRecentMessages should return canonical phone JID for LID messages", () => {
    const results = getRecentMessages(10) as Array<{ text?: string; chat: string }>;

    // Should include messages from both LID and phone JIDs
    expect(results.length).toBeGreaterThan(0);

    // Find a message from the Panama Equity contact
    const panamaMsgs = results.filter((r) => r.text?.includes("apartment") || r.text?.includes("deposit"));
    expect(panamaMsgs.length).toBeGreaterThan(0);

    // All Panama Equity messages should have canonical phone JID
    for (const msg of panamaMsgs) {
      expect(msg.chat).toBe("50763345671@s.whatsapp.net");
      expect(msg.chat).not.toBe("169509591765046@lid");
    }
  });

  it("searchMessages should not duplicate results for mapped contacts", () => {
    const results = searchMessages("apartment") as Array<{ text?: string; chat: string }>;

    // Count how many results have the apartment text
    const apartmentResults = results.filter((r) => r.text?.includes("apartment"));

    // Should have exactly one result (not duplicated for LID and phone)
    expect(apartmentResults).toHaveLength(1);
    expect(apartmentResults[0]?.chat).toBe("50763345671@s.whatsapp.net");
  });
});
