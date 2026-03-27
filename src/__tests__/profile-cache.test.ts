import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

describe("profile cache", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-profile-test-"));
    dbPath = path.join(tmpDir, "test.db");
    db = new Database(dbPath);
    // Create the user_profile table manually for testing
    db.exec(`
      CREATE TABLE user_profile (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        jid             TEXT NOT NULL,
        lid_jid         TEXT,
        name            TEXT,
        updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upserts user profile with all fields", () => {
    const jid = "1234567890@s.whatsapp.net";
    const lidJid = "1234567890@lid";
    const name = "Test User";

    const stmt = db.prepare(`
      INSERT INTO user_profile (id, jid, lid_jid, name, updated_at)
      VALUES (1, ?, ?, ?, unixepoch())
      ON CONFLICT(id) DO UPDATE SET
        jid = excluded.jid,
        lid_jid = excluded.lid_jid,
        name = excluded.name,
        updated_at = unixepoch()
    `);
    stmt.run(jid, lidJid, name);

    const profile = db.prepare("SELECT jid, lid_jid, name FROM user_profile WHERE id = 1").get() as { jid: string; lid_jid: string | null; name: string | null };
    expect(profile).not.toBeNull();
    expect(profile.jid).toBe(jid);
    expect(profile.lid_jid).toBe(lidJid);
    expect(profile.name).toBe(name);
  });

  it("upserts user profile with null lid_jid", () => {
    const jid = "1234567890@s.whatsapp.net";
    const name = "Test User";

    const stmt = db.prepare(`
      INSERT INTO user_profile (id, jid, lid_jid, name, updated_at)
      VALUES (1, ?, ?, ?, unixepoch())
      ON CONFLICT(id) DO UPDATE SET
        jid = excluded.jid,
        lid_jid = excluded.lid_jid,
        name = excluded.name,
        updated_at = unixepoch()
    `);
    stmt.run(jid, null, name);

    const profile = db.prepare("SELECT jid, lid_jid, name FROM user_profile WHERE id = 1").get() as { jid: string; lid_jid: string | null; name: string | null };
    expect(profile).not.toBeNull();
    expect(profile.jid).toBe(jid);
    expect(profile.lid_jid).toBeNull();
    expect(profile.name).toBe(name);
  });

  it("upserts user profile with null name", () => {
    const jid = "1234567890@s.whatsapp.net";
    const lidJid = "1234567890@lid";

    const stmt = db.prepare(`
      INSERT INTO user_profile (id, jid, lid_jid, name, updated_at)
      VALUES (1, ?, ?, ?, unixepoch())
      ON CONFLICT(id) DO UPDATE SET
        jid = excluded.jid,
        lid_jid = excluded.lid_jid,
        name = excluded.name,
        updated_at = unixepoch()
    `);
    stmt.run(jid, lidJid, null);

    const profile = db.prepare("SELECT jid, lid_jid, name FROM user_profile WHERE id = 1").get() as { jid: string; lid_jid: string | null; name: string | null };
    expect(profile).not.toBeNull();
    expect(profile.jid).toBe(jid);
    expect(profile.lid_jid).toBe(lidJid);
    expect(profile.name).toBeNull();
  });

  it("replaces existing profile on second upsert", () => {
    const jid1 = "1111111111@s.whatsapp.net";
    const jid2 = "2222222222@s.whatsapp.net";
    const name1 = "User One";
    const name2 = "User Two";

    const stmt = db.prepare(`
      INSERT INTO user_profile (id, jid, lid_jid, name, updated_at)
      VALUES (1, ?, ?, ?, unixepoch())
      ON CONFLICT(id) DO UPDATE SET
        jid = excluded.jid,
        lid_jid = excluded.lid_jid,
        name = excluded.name,
        updated_at = unixepoch()
    `);

    stmt.run(jid1, null, name1);
    let profile = db.prepare("SELECT jid, lid_jid, name FROM user_profile WHERE id = 1").get() as { jid: string; lid_jid: string | null; name: string | null };
    expect(profile.jid).toBe(jid1);
    expect(profile.name).toBe(name1);

    // Upsert again with different data
    stmt.run(jid2, null, name2);
    profile = db.prepare("SELECT jid, lid_jid, name FROM user_profile WHERE id = 1").get() as { jid: string; lid_jid: string | null; name: string | null };
    expect(profile.jid).toBe(jid2);
    expect(profile.name).toBe(name2);
  });

  it("returns null when no profile exists", () => {
    const profile = db.prepare("SELECT jid, lid_jid, name FROM user_profile WHERE id = 1").get();
    expect(profile).toBeUndefined();
  });

  it("maintains singleton constraint (only one row with id=1)", () => {
    const stmt = db.prepare(`
      INSERT INTO user_profile (id, jid, lid_jid, name, updated_at)
      VALUES (1, ?, ?, ?, unixepoch())
      ON CONFLICT(id) DO UPDATE SET
        jid = excluded.jid,
        lid_jid = excluded.lid_jid,
        name = excluded.name,
        updated_at = unixepoch()
    `);

    stmt.run("1111111111@s.whatsapp.net", null, "User One");
    stmt.run("2222222222@s.whatsapp.net", null, "User Two");

    const rows = db.prepare("SELECT COUNT(*) as cnt FROM user_profile").get() as { cnt: number };
    expect(rows.cnt).toBe(1);

    const profile = db.prepare("SELECT jid FROM user_profile WHERE id = 1").get() as { jid: string };
    expect(profile.jid).toBe("2222222222@s.whatsapp.net");
  });
});
