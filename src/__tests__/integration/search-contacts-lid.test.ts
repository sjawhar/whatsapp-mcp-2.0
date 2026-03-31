import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, seedLidTestData, setupTestDb } from "../helpers/test-db.js";
import { searchContacts } from "../../db.js";

describe("integration: searchContacts with LID/phone deduplication", () => {
  beforeAll(async () => {
    await setupTestDb();
    seedLidTestData();
  });

  afterAll(() => {
    closeTestDb();
  });

  it("should return ONE result when searching by name (Panama Equity)", () => {
    const results = searchContacts("Panama Equity");

    // Should have exactly one result (merged from LID and phone JID)
    expect(results).toHaveLength(1);

    // Should use the phone JID as canonical
    expect(results[0]?.jid).toBe("50763345671@s.whatsapp.net");
    expect(results[0]?.name).toBe("Panama Equity");
    expect(results[0]?.phone).toBe("50763345671");
    expect(results[0]?.isGroup).toBe(false);
  });

  it("should return ONE result when searching by phone number", () => {
    const results = searchContacts("50763345671");

    // Should have exactly one result
    expect(results).toHaveLength(1);

    // Should use the phone JID as canonical
    expect(results[0]?.jid).toBe("50763345671@s.whatsapp.net");
    expect(results[0]?.name).toBe("Panama Equity");
    expect(results[0]?.phone).toBe("50763345671");
  });

  it("should include unmapped LID contacts with their LID as jid", () => {
    const results = searchContacts("Unknown Broker");

    // Should have exactly one result for the unmapped LID
    expect(results).toHaveLength(1);

    // Should use the LID JID since it's unmapped
    expect(results[0]?.jid).toBe("999999999@lid");
    expect(results[0]?.name).toBe("Unknown Broker");
    expect(results[0]?.isGroup).toBe(false);
  });

  it("should not duplicate results for mapped contacts", () => {
    const results = searchContacts("Panama");

    // Should have exactly one result (not two for LID and phone)
    expect(results).toHaveLength(1);
    expect(results[0]?.jid).toBe("50763345671@s.whatsapp.net");
  });
});
