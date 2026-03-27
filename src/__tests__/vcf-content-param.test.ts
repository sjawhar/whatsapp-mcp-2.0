import { describe, expect, it } from "vitest";
import { importContactsFromVcf } from "../import-contacts.js";

// Create a minimal mock database that satisfies the Database interface
function createMockDb() {
  const contacts: Record<string, any> = {};
  const chats: Record<string, any> = {};

  return {
    prepare: (sql: string) => ({
      all: () => {
        if (sql.includes("SELECT jid FROM contacts")) {
          return Object.values(contacts);
        }
        if (sql.includes("SELECT jid FROM chats")) {
          return Object.values(chats);
        }
        return [];
      },
      get: () => {
        if (sql.includes("SELECT COUNT")) {
          return { cnt: 0 };
        }
        return null;
      },
      run: (params: any) => {
        if (sql.includes("INSERT INTO contacts")) {
          contacts[params.jid] = { jid: params.jid, name: params.name };
        } else if (sql.includes("INSERT INTO chats")) {
          chats[params.jid] = { jid: params.jid, name: params.name };
        }
        return { changes: 1 };
      },
    }),
    transaction: (fn: () => void) => fn,
  } as any;
}

describe("importContactsFromVcf with vcfContent parameter", () => {
  it("accepts vcfContent as a string and parses it directly", () => {
    const vcfContent = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Alice Test",
      "TEL:+1 555 000 1111",
      "END:VCARD",
      "",
    ].join("\n");

    const db = createMockDb();
    const result = importContactsFromVcf(db, vcfContent);

    expect(result.success).toBe(true);
    expect(result.totalParsed).toBe(1);
    expect(result.vcfPath).toBe("[provided-content]");
  });

  it("parses multiple contacts from vcfContent", () => {
    const vcfContent = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Alice Test",
      "TEL:+1 555 000 1111",
      "END:VCARD",
      "",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Bob Test",
      "TEL:+1 555 000 2222",
      "END:VCARD",
      "",
    ].join("\n");

    const db = createMockDb();
    const result = importContactsFromVcf(db, vcfContent);

    expect(result.success).toBe(true);
    expect(result.totalParsed).toBe(2);
    expect(result.vcfPath).toBe("[provided-content]");
  });

  it("handles vcfContent with multiple phone numbers per contact", () => {
    const vcfContent = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Alice Test",
      "TEL:+1 555 000 1111",
      "TEL:+1 555 000 1112",
      "END:VCARD",
      "",
    ].join("\n");

    const db = createMockDb();
    const result = importContactsFromVcf(db, vcfContent);

    expect(result.success).toBe(true);
    expect(result.totalParsed).toBe(1);
  });

  it("ignores contacts without phone numbers in vcfContent", () => {
    const vcfContent = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Alice Test",
      "TEL:+1 555 000 1111",
      "END:VCARD",
      "",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Bob Test",
      "END:VCARD",
      "",
    ].join("\n");

    const db = createMockDb();
    const result = importContactsFromVcf(db, vcfContent);

    expect(result.success).toBe(true);
    expect(result.totalParsed).toBe(1); // Only Alice, Bob has no phone
  });

  it("handles vcfContent with N field instead of FN", () => {
    const vcfContent = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:Test;Charlie",
      "TEL:+1 555 000 3333",
      "END:VCARD",
      "",
    ].join("\n");

    const db = createMockDb();
    const result = importContactsFromVcf(db, vcfContent);

    expect(result.success).toBe(true);
    expect(result.totalParsed).toBe(1);
  });

  it("returns vcfPath as [provided-content] when vcfContent is used", () => {
    const vcfContent = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Test User",
      "TEL:+1 555 000 9999",
      "END:VCARD",
      "",
    ].join("\n");

    const db = createMockDb();
    const result = importContactsFromVcf(db, vcfContent);

    expect(result.vcfPath).toBe("[provided-content]");
  });
});
