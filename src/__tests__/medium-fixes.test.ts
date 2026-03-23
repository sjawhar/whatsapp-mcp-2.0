import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, seedTestDb, setupTestDb } from "./helpers/test-db.js";
import { createMcpTestClient, type McpTestClient } from "./helpers/mcp-test-client.js";
import path from "path";

// ─── Fix 1: JID device suffix stripping ─────────────────────────────

describe("toJid — device suffix stripping", () => {
  let toJid: (input: string) => string;

  beforeAll(async () => {
    const utils = await import("../utils.js");
    toJid = utils.toJid;
  });

  it("strips device suffix from phone JID", () => {
    expect(toJid("1234567890:5@s.whatsapp.net")).toBe("1234567890@s.whatsapp.net");
  });

  it("strips multi-digit device suffix", () => {
    expect(toJid("9876543210:42@s.whatsapp.net")).toBe("9876543210@s.whatsapp.net");
  });

  it("passes through normal phone JID unchanged", () => {
    expect(toJid("1234567890@s.whatsapp.net")).toBe("1234567890@s.whatsapp.net");
  });

  it("passes through group JID unchanged", () => {
    expect(toJid("123456789-987654321@g.us")).toBe("123456789-987654321@g.us");
  });

  it("passes through LID JID unchanged", () => {
    expect(toJid("12345@lid")).toBe("12345@lid");
  });

  it("normalizes bare phone number to JID", () => {
    expect(toJid("1234567890")).toBe("1234567890@s.whatsapp.net");
  });

  it("strips + prefix from phone number", () => {
    expect(toJid("+1234567890")).toBe("1234567890@s.whatsapp.net");
  });
});

// ─── Fix 2: Search LIKE wildcard escaping ────────────────────────────

describe("searchMessages — LIKE wildcard escaping", () => {
  let dbModule: typeof import("../db.js");

  beforeAll(async () => {
    await setupTestDb();
    seedTestDb();
    dbModule = await import("../db.js");

    // Insert messages with specific content for wildcard tests
    const db = dbModule.getDb();
    db.prepare(
      "INSERT INTO messages (id, chat_jid, from_me, type, text, timestamp, has_media) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("msg-percent", "15550001111@s.whatsapp.net", 0, "text", "100% done", 1700000010, 0);

    db.prepare(
      "INSERT INTO messages (id, chat_jid, from_me, type, text, timestamp, has_media) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("msg-underscore", "15550001111@s.whatsapp.net", 0, "text", "use_snake_case", 1700000020, 0);

    db.prepare(
      "INSERT INTO messages (id, chat_jid, from_me, type, text, timestamp, has_media) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("msg-normal", "15550001111@s.whatsapp.net", 0, "text", "normal message", 1700000030, 0);
  });

  afterAll(() => {
    closeTestDb();
  });

  it("searching '%' does NOT match all messages", () => {
    const results = dbModule.searchMessages("%");
    // Should only match messages containing a literal "%" character
    expect(results.length).toBeLessThanOrEqual(1);
    if (results.length > 0) {
      expect(results.every((r: any) => typeof r.text === "string" && r.text.includes("%"))).toBe(true);
    }
  });

  it("searching '_' does NOT match single characters", () => {
    const results = dbModule.searchMessages("_");
    // Should only match messages containing a literal "_" character
    for (const r of results) {
      expect(typeof r.text === "string" && r.text.includes("_")).toBe(true);
    }
  });

  it("finds messages with literal % in text", () => {
    const results = dbModule.searchMessages("100%");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r: any) => r.text === "100% done")).toBe(true);
  });

  it("finds messages with literal _ in text", () => {
    const results = dbModule.searchMessages("snake_case");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r: any) => r.text === "use_snake_case")).toBe(true);
  });

  it("normal substring search still works", () => {
    const results = dbModule.searchMessages("normal");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r: any) => r.text === "normal message")).toBe(true);
  });
});

// ─── Fix 3: VCF path containment ────────────────────────────────────

describe("importContactsFromVcf — path containment", () => {
  let importContactsFromVcf: typeof import("../import-contacts.js")["importContactsFromVcf"];
  let Database: any;

  beforeAll(async () => {
    const mod = await import("../import-contacts.js");
    importContactsFromVcf = mod.importContactsFromVcf;
    const dbMod = await import("better-sqlite3");
    Database = (dbMod.default ?? dbMod) as any;
  });

  it("rejects /etc/passwd as VCF path", () => {
    // Create a minimal in-memory DB with schema
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, conversation_ts INTEGER DEFAULT 0, unread_count INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS contacts (jid TEXT PRIMARY KEY, name TEXT, notify TEXT);
    `);

    expect(() => importContactsFromVcf(db, "/etc/passwd")).toThrow(/VCF path not allowed/);
    db.close();
  });

  it("rejects path traversal attempts", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, conversation_ts INTEGER DEFAULT 0, unread_count INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS contacts (jid TEXT PRIMARY KEY, name TEXT, notify TEXT);
    `);

    expect(() => importContactsFromVcf(db, "../../../etc/shadow")).toThrow(/VCF path not allowed/);
    db.close();
  });
});

// ─── Fix 4: list_chats limit passthrough ─────────────────────────────

describe("list_chats — limit passthrough to DB", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    // Re-setup DB for MCP client tests (clean state)
    await setupTestDb();
    const dbModule = await import("../db.js");
    const db = dbModule.getDb();

    // Seed 10 chats with messages
    for (let i = 1; i <= 10; i++) {
      const jid = `1555000${String(i).padStart(4, "0")}@s.whatsapp.net`;
      db.prepare("INSERT OR REPLACE INTO chats (jid, name, conversation_ts, unread_count) VALUES (?, ?, ?, ?)").run(
        jid, `Contact ${i}`, 1700000000 + i * 100, 0
      );
      db.prepare(
        "INSERT OR REPLACE INTO messages (id, chat_jid, from_me, type, text, timestamp, has_media) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(`msg-${i}`, jid, 0, "text", `Message from contact ${i}`, 1700000000 + i * 100, 0);
    }

    client = await createMcpTestClient();
  });

  afterAll(async () => {
    await client?.close();
    closeTestDb();
  });

  it("returns at most `limit` chats from DB", async () => {
    const result = await client.callTool("list_chats", { limit: 5 });
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBeLessThanOrEqual(5);
  });

  it("returns more chats with higher limit", async () => {
    const result = await client.callTool("list_chats", { limit: 100 });
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBeGreaterThanOrEqual(10);
  });
});
