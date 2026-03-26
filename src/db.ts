import Database from "better-sqlite3";
import type { WAMessage } from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import { fromJid, formatMessageRow } from "./utils.js";
import { STORE_DIR } from "./paths.js";

const DB_PATH = path.join(STORE_DIR, "whatsapp.db");

let db: Database.Database;

// ─── Message helpers (moved from utils.ts) ──────────────────────────

function getMessageText(msg: { message?: Record<string, any> | null }): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.listResponseMessage?.title ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    null
  );
}

function getMessageType(msg: { message?: Record<string, any> | null }): string {
  const m = msg.message;
  if (!m) return "unknown";
  if (m.conversation || m.extendedTextMessage) return "text";
  if (m.imageMessage) return "image";
  if (m.videoMessage) return "video";
  if (m.audioMessage) return m.audioMessage.ptt ? "voice_note" : "audio";
  if (m.documentMessage) return "document";
  if (m.stickerMessage) return "sticker";
  if (m.contactMessage) return "contact";
  if (m.locationMessage) return "location";
  if (m.reactionMessage) return "reaction";
  if (m.protocolMessage) return "protocol";
  return "other";
}

function isUserMessage(msg: { message?: Record<string, any> | null }): boolean {
  const m = msg.message;
  if (!m) return false;
  if (m.protocolMessage || m.reactionMessage || m.senderKeyDistributionMessage) return false;
  return true;
}

const MEDIA_TYPES = new Set(["image", "video", "audio", "voice_note", "document", "sticker"]);

// ─── Schema ─────────────────────────────────────────────────────────

function createTables() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS chats (
      jid              TEXT PRIMARY KEY,
      name             TEXT,
      conversation_ts  INTEGER DEFAULT 0,
      unread_count     INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS contacts (
      jid    TEXT PRIMARY KEY,
      name   TEXT,
      notify TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT NOT NULL,
      chat_jid     TEXT NOT NULL,
      from_me      INTEGER NOT NULL DEFAULT 0,
      sender_jid   TEXT,
      sender_name  TEXT,
      type         TEXT NOT NULL DEFAULT 'text',
      text         TEXT,
      timestamp    INTEGER NOT NULL DEFAULT 0,
      has_media    INTEGER NOT NULL DEFAULT 0,
      message_blob TEXT,
      PRIMARY KEY (chat_jid, id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_text ON messages(text) WHERE text IS NOT NULL;

    CREATE TABLE IF NOT EXISTS jid_mapping (
      lid_jid   TEXT PRIMARY KEY,
      phone_jid TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jid_mapping_phone ON jid_mapping(phone_jid);
  `);

  // Migration: add transcription column for voice note caching
  const hasCol = db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('messages') WHERE name = 'transcription'`
  ).get() as { cnt: number };
  if (hasCol.cnt === 0) {
    db.exec(`ALTER TABLE messages ADD COLUMN transcription TEXT`);
  }

  // Seed JID mappings from name-matched chats (LID ↔ phone number).
  // WhatsApp is migrating from phone JIDs to LID JIDs, so the same contact
  // may have messages under both. This bootstraps the mapping from existing data.
  db.exec(`
    INSERT OR IGNORE INTO jid_mapping (lid_jid, phone_jid)
    SELECT l.jid, p.jid
    FROM chats l
    JOIN chats p ON p.name = l.name AND p.jid LIKE '%@s.whatsapp.net'
    WHERE l.jid LIKE '%@lid'
      AND l.name IS NOT NULL AND l.name != ''
  `);
}

// ─── Prepared Statements ────────────────────────────────────────────

let stmts: {
  upsertChat: Database.Statement;
  upsertContact: Database.Statement;
  upsertMessage: Database.Statement;
  deleteChat: Database.Statement;
  deleteMessage: Database.Statement;
  getContactName: Database.Statement;
};

function prepareStatements() {
  stmts = {
    upsertChat: db.prepare(`
      INSERT INTO chats (jid, name, conversation_ts, unread_count)
      VALUES (@jid, @name, @conversation_ts, @unread_count)
      ON CONFLICT(jid) DO UPDATE SET
        name = COALESCE(@name, chats.name),
        conversation_ts = MAX(COALESCE(@conversation_ts, 0), chats.conversation_ts),
        unread_count = COALESCE(@unread_count, chats.unread_count)
    `),
    upsertContact: db.prepare(`
      INSERT INTO contacts (jid, name, notify)
      VALUES (@jid, @name, @notify)
      ON CONFLICT(jid) DO UPDATE SET
        name = COALESCE(@name, contacts.name),
        notify = COALESCE(@notify, contacts.notify)
    `),
    upsertMessage: db.prepare(`
      INSERT INTO messages (id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media, message_blob)
      VALUES (@id, @chat_jid, @from_me, @sender_jid, @sender_name, @type, @text, @timestamp, @has_media, @message_blob)
      ON CONFLICT(chat_jid, id) DO UPDATE SET
        sender_name = COALESCE(@sender_name, messages.sender_name),
        text = COALESCE(@text, messages.text),
        has_media = @has_media,
        message_blob = COALESCE(@message_blob, messages.message_blob)
    `),
    deleteChat: db.prepare(`DELETE FROM chats WHERE jid = ?`),
    deleteMessage: db.prepare(`DELETE FROM messages WHERE chat_jid = ? AND id = ?`),
    getContactName: db.prepare(`
      SELECT COALESCE(name, notify) AS display FROM contacts WHERE jid = ?
    `),
  };
}

// ─── Write Operations ───────────────────────────────────────────────

export function upsertChat(jid: string, name?: string | null, conversationTs?: number | null, unreadCount?: number | null) {
  stmts.upsertChat.run({
    jid,
    name: name || null,
    conversation_ts: conversationTs ? Number(conversationTs) : null,
    unread_count: unreadCount ?? null,
  });
}

export function upsertContact(jid: string, name?: string | null, notify?: string | null) {
  stmts.upsertContact.run({ jid, name: name || null, notify: notify || null });
}

function resolveSenderName(senderJid: string | null): string | null {
  if (!senderJid) return null;
  const row = stmts.getContactName.get(senderJid) as { display: string } | undefined;
  if (row?.display) return row.display;
  return fromJid(senderJid);
}

export function upsertMessage(chatJid: string, msg: WAMessage) {
  if (!isUserMessage(msg as any)) return;
  const type = getMessageType(msg as any);
  const text = getMessageText(msg as any);
  const fromMe = msg.key.fromMe ? 1 : 0;
  const senderJid = fromMe ? null : (msg.key.participant || msg.key.remoteJid || null);
  const senderName = fromMe ? null : resolveSenderName(senderJid);
  const hasMedia = MEDIA_TYPES.has(type) ? 1 : 0;
  const messageBlob = hasMedia ? JSON.stringify({ key: msg.key, message: msg.message, messageTimestamp: msg.messageTimestamp }) : null;

  stmts.upsertMessage.run({
    id: msg.key.id,
    chat_jid: chatJid,
    from_me: fromMe,
    sender_jid: senderJid,
    sender_name: senderName,
    type,
    text: text || null,
    timestamp: Number(msg.messageTimestamp || 0),
    has_media: hasMedia,
    message_blob: messageBlob,
  });
}

export function upsertChats(chats: Array<{ id: string; name?: string | null; conversationTimestamp?: any; unreadCount?: number | null }>) {
  const run = db.transaction((items: typeof chats) => {
    for (const chat of items) {
      upsertChat(chat.id, chat.name, chat.conversationTimestamp ? Number(chat.conversationTimestamp) : null, chat.unreadCount);
    }
  });
  run(chats);
}

export function upsertContacts(contacts: Array<{ id: string; name?: string | null; notify?: string | null }>) {
  const run = db.transaction((items: typeof contacts) => {
    for (const contact of items) {
      upsertContact(contact.id, contact.name, contact.notify);
    }
  });
  run(contacts);
}

export function upsertMessages(chatJid: string, msgs: WAMessage[]) {
  const run = db.transaction((items: WAMessage[]) => {
    for (const msg of items) {
      upsertMessage(chatJid, msg);
    }
  });
  run(msgs);
}

export function deleteChat(jid: string) {
  stmts.deleteChat.run(jid);
}

export function deleteMessage(chatJid: string, messageId: string): boolean {
  const result = stmts.deleteMessage.run(chatJid, messageId);
  return result.changes > 0;
}

// ─── JID Mapping (LID ↔ Phone) ──────────────────────────────────────

export function saveJidMapping(lidJid: string, phoneJid: string): void {
  db.prepare(`INSERT OR REPLACE INTO jid_mapping (lid_jid, phone_jid) VALUES (?, ?)`).run(lidJid, phoneJid);
}

export function getPhoneJid(lidJid: string): string | null {
  const row = db.prepare(`SELECT phone_jid FROM jid_mapping WHERE lid_jid = ?`).get(lidJid) as { phone_jid: string } | undefined;
  return row?.phone_jid || null;
}

export function getLidJid(phoneJid: string): string | null {
  const row = db.prepare(`SELECT lid_jid FROM jid_mapping WHERE phone_jid = ?`).get(phoneJid) as { lid_jid: string } | undefined;
  return row?.lid_jid || null;
}

export function getUnmappedLidJids(): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT c.jid FROM chats c
    WHERE c.jid LIKE '%@lid'
    AND c.jid NOT IN (SELECT lid_jid FROM jid_mapping)
    UNION
    SELECT DISTINCT co.jid FROM contacts co
    WHERE co.jid LIKE '%@lid'
    AND co.jid NOT IN (SELECT lid_jid FROM jid_mapping)
  `).all() as { jid: string }[];
  return rows.map(r => r.jid);
}

/**
 * Return all known JIDs for a contact — the input JID plus any mapped counterpart.
 * If a phone JID is given, also returns the LID JID (and vice versa).
 */
export function getAllJidsFor(jid: string): string[] {
  const jids = [jid];
  if (jid.endsWith("@lid")) {
    const phone = getPhoneJid(jid);
    if (phone) jids.push(phone);
  } else if (jid.endsWith("@s.whatsapp.net")) {
    const lid = getLidJid(jid);
    if (lid) jids.push(lid);
  }
  return jids;
}

export function getMessageFromMe(chatJid: string, messageId: string): boolean | null {
  const row = db.prepare(`SELECT from_me FROM messages WHERE chat_jid = ? AND id = ?`).get(chatJid, messageId) as { from_me: number } | undefined;
  if (!row) return null;
  return row.from_me === 1;
}

// ─── Read Operations ────────────────────────────────────────────────

export function resolveDisplayName(jid: string): string {
  const row = db.prepare(`
    SELECT COALESCE(ch.name, co.name, co.notify, ch.jid) AS display_name
    FROM chats ch
    LEFT JOIN contacts co ON ch.jid = co.jid
    WHERE ch.jid = ?
  `).get(jid) as { display_name: string } | undefined;

  if (row?.display_name) return row.display_name;

  // Fallback: check contacts directly (chat may not exist yet)
  const contact = stmts.getContactName.get(jid) as { display: string } | undefined;
  if (contact?.display) return contact.display;

  return fromJid(jid);
}

export function getChats(nameFilter?: string, limit: number = 100): Record<string, unknown>[] {
  let sql = `
    SELECT ch.jid, COALESCE(ch.name, co.name, co.notify) AS name,
           ch.unread_count, m.max_ts AS effective_ts
    FROM chats ch
    LEFT JOIN contacts co ON ch.jid = co.jid
    INNER JOIN (
      SELECT chat_jid, MAX(timestamp) AS max_ts
      FROM messages
      WHERE timestamp > 0
      GROUP BY chat_jid
    ) m ON ch.jid = m.chat_jid
    WHERE ch.jid NOT LIKE '0@%'
      AND ch.jid != 'status@broadcast'
  `;
  const params: any[] = [];

  if (nameFilter) {
    sql += ` AND COALESCE(ch.name, co.name, co.notify, ch.jid) LIKE ?`;
    params.push(`%${nameFilter}%`);
  }

  sql += ` ORDER BY effective_ts DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    jid: string;
    name: string | null;
    unread_count: number;
    effective_ts: number;
  }>;

  // Merge LID chats into their phone JID counterparts to avoid duplicates.
  // If both a LID and phone JID exist for the same contact, keep the phone JID
  // entry with the latest timestamp from either.
  const merged = new Map<string, { jid: string; name: string | null; unread_count: number; effective_ts: number }>();
  for (const r of rows) {
    let canonicalJid = r.jid;
    if (r.jid.endsWith("@lid")) {
      const phone = getPhoneJid(r.jid);
      if (phone) canonicalJid = phone;
    }
    const existing = merged.get(canonicalJid);
    if (existing) {
      // Merge: keep the latest timestamp, sum unread, prefer non-null name
      existing.effective_ts = Math.max(existing.effective_ts, r.effective_ts);
      existing.unread_count += r.unread_count || 0;
      if (!existing.name && r.name) existing.name = r.name;
    } else {
      merged.set(canonicalJid, { jid: canonicalJid, name: r.name, unread_count: r.unread_count, effective_ts: r.effective_ts });
    }
  }

  // Re-sort by effective_ts after merging
  const result = [...merged.values()].sort((a, b) => b.effective_ts - a.effective_ts);

  return result.map((r) => ({
    jid: r.jid,
    name: r.name || (r.jid.endsWith("@lid") ? "Unknown" : fromJid(r.jid)),
    unreadCount: r.unread_count || 0,
    lastMessageTime: r.effective_ts,
    isGroup: r.jid.endsWith("@g.us"),
  }));
}

export function getChat(jid: string): Record<string, unknown> {
  const jids = getAllJidsFor(jid);
  const placeholders = jids.map(() => "?").join(", ");

  // Query all JID variants and pick the one with the best data
  const chats = db.prepare(`
    SELECT ch.jid, COALESCE(ch.name, co.name, co.notify) AS name,
           ch.unread_count, ch.conversation_ts
    FROM chats ch
    LEFT JOIN contacts co ON ch.jid = co.jid
    WHERE ch.jid IN (${placeholders})
  `).all(...jids) as Array<{ jid: string; name: string | null; unread_count: number; conversation_ts: number }>;

  if (chats.length === 0) {
    throw new Error(`Chat not found: ${jid}`);
  }

  // Merge: use the best name, latest timestamp, sum unread counts
  const name = chats.find(c => c.name)?.name || null;
  const conversationTs = Math.max(...chats.map(c => c.conversation_ts || 0));
  const unreadCount = chats.reduce((sum, c) => sum + (c.unread_count || 0), 0);
  const primaryJid = chats.find(c => c.jid === jid)?.jid || chats[0].jid;

  // getMessages already merges across JID variants
  const recentMessages = getMessages(jid, 5).reverse();

  return {
    jid: primaryJid,
    name: name || fromJid(primaryJid),
    unreadCount,
    lastMessageTime: conversationTs || null,
    isGroup: primaryJid.endsWith("@g.us"),
    recentMessages,
  };
}

export function getMessages(jid: string, limit: number = 50): Record<string, unknown>[] {
  const jids = getAllJidsFor(jid);
  const placeholders = jids.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media
    FROM messages
    WHERE chat_jid IN (${placeholders})
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(...jids, limit) as Array<{
    id: string; chat_jid: string; from_me: number; sender_jid: string | null;
    sender_name: string | null; type: string; text: string | null;
    timestamp: number; has_media: number;
  }>;

  return rows.map(formatMessageRow);
}

export function searchMessages(query: string, jid?: string): Record<string, unknown>[] {
  let sql = `
    SELECT id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media
    FROM messages
    WHERE text LIKE ? ESCAPE '\\'
  `;
  const escaped = query.replace(/[%_\\]/g, "\\$&");
  const params: any[] = [`%${escaped}%`];

  if (jid) {
    const jids = getAllJidsFor(jid);
    const placeholders = jids.map(() => "?").join(", ");
    sql += ` AND chat_jid IN (${placeholders})`;
    params.push(...jids);
  }

  sql += ` ORDER BY timestamp DESC LIMIT 50`;

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string; chat_jid: string; from_me: number; sender_jid: string | null;
    sender_name: string | null; type: string; text: string | null;
    timestamp: number; has_media: number;
  }>;

  return rows.map((r) => ({
    ...formatMessageRow(r),
    chat: r.chat_jid,
  }));
}

export function searchContacts(query: string): Record<string, unknown>[] {
  const rows = db.prepare(`
    SELECT jid, name, notify
    FROM contacts
    WHERE name LIKE ? OR notify LIKE ? OR jid LIKE ?
  `).all(`%${query}%`, `%${query}%`, `%${query}%`) as Array<{
    jid: string; name: string | null; notify: string | null;
  }>;

  return rows.map((r) => ({
    jid: r.jid,
    name: r.name || r.notify || fromJid(r.jid),
    phone: fromJid(r.jid),
    isGroup: r.jid.endsWith("@g.us"),
  }));
}

export function getMessageContext(jid: string, messageId: string, count: number = 5): Record<string, unknown> {
  const jids = getAllJidsFor(jid);
  const placeholders = jids.map(() => "?").join(", ");

  // Find the target message timestamp
  const target = db.prepare(`
    SELECT timestamp FROM messages WHERE chat_jid IN (${placeholders}) AND id = ?
  `).get(...jids, messageId) as { timestamp: number } | undefined;

  if (!target) {
    throw new Error(`Message ${messageId} not found in chat ${jid}`);
  }

  // Get messages before (inclusive of target)
  const before = db.prepare(`
    SELECT id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media
    FROM messages
    WHERE chat_jid IN (${placeholders}) AND timestamp <= ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(...jids, target.timestamp, count + 1) as any[];

  // Get messages after target
  const after = db.prepare(`
    SELECT id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media
    FROM messages
    WHERE chat_jid IN (${placeholders}) AND timestamp > ?
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(...jids, target.timestamp, count) as any[];

  const allMessages = [...before.reverse(), ...after];
  const targetIndex = before.length - 1;

  return {
    messages: allMessages.map(formatMessageRow),
    targetIndex,
  };
}

export function getMessageBlob(jid: string, messageId: string): string | null {
  const jids = getAllJidsFor(jid);
  const placeholders = jids.map(() => "?").join(", ");
  const row = db.prepare(`
    SELECT message_blob FROM messages WHERE chat_jid IN (${placeholders}) AND id = ?
  `).get(...jids, messageId) as { message_blob: string | null } | undefined;

  return row?.message_blob || null;
}

export function getMessageTypeById(chatJid: string, messageId: string): string | null {
  const jids = getAllJidsFor(chatJid);
  const placeholders = jids.map(() => "?").join(", ");
  const row = db.prepare(
    `SELECT type FROM messages WHERE chat_jid IN (${placeholders}) AND id = ?`
  ).get(...jids, messageId) as { type: string } | undefined;
  return row?.type || null;
}

export function getTranscription(chatJid: string, messageId: string): string | null {
  const jids = getAllJidsFor(chatJid);
  const placeholders = jids.map(() => "?").join(", ");
  const row = db.prepare(
    `SELECT transcription FROM messages WHERE chat_jid IN (${placeholders}) AND id = ?`
  ).get(...jids, messageId) as { transcription: string | null } | undefined;
  return row?.transcription || null;
}

export function saveTranscription(chatJid: string, messageId: string, transcription: string): void {
  // Update across all JID variants since we don't know which one holds the message
  const jids = getAllJidsFor(chatJid);
  const placeholders = jids.map(() => "?").join(", ");
  db.prepare(
    `UPDATE messages SET transcription = ? WHERE chat_jid IN (${placeholders}) AND id = ?`
  ).run(transcription, ...jids, messageId);
}

export function getLastMessageKey(jid: string): { id: string; fromMe: boolean; remoteJid: string; timestamp: number } | null {
  const row = db.prepare(`
    SELECT id, from_me, chat_jid, timestamp FROM messages
    WHERE chat_jid = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(jid) as { id: string; from_me: number; chat_jid: string; timestamp: number } | undefined;

  if (!row) return null;
  return { id: row.id, fromMe: row.from_me === 1, remoteJid: row.chat_jid, timestamp: row.timestamp };
}

export function deleteChatMessages(jid: string) {
  db.prepare(`DELETE FROM messages WHERE chat_jid = ?`).run(jid);
}

export function getChatName(jid: string): string | null {
  const row = db.prepare(`SELECT name FROM chats WHERE jid = ?`).get(jid) as { name: string | null } | undefined;
  return row?.name || null;
}

export function getContactName(jid: string): string | null {
  const row = db.prepare(`SELECT name, notify FROM contacts WHERE jid = ?`).get(jid) as { name: string | null; notify: string | null } | undefined;
  return row?.name || row?.notify || null;
}

/** Return the raw better-sqlite3 instance (for use by import-contacts). */
export function getDb(): Database.Database {
  return db;
}

// ─── Init / Close ───────────────────────────────────────────────────

export function initDb() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  db = new Database(DB_PATH);
  createTables();
  prepareStatements();
  console.error(`Database initialized at ${DB_PATH}`);
}

export function closeDb() {
  if (db) {
    db.close();
    console.error("Database closed");
  }
}
