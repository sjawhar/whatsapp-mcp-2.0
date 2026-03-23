#!/usr/bin/env node
/**
 * Import phone contacts from a .vcf (vCard) file into the WhatsApp MCP database.
 *
 * Usage (standalone CLI):
 *   npx tsx src/import-contacts.ts contacts.vcf
 *   npx tsx src/import-contacts.ts contacts.vcf --dry-run
 *
 * Also exports `importContactsFromVcf()` for use by the MCP tool.
 *
 * Export your contacts from iPhone:
 *   Settings > Contacts > Accounts > iCloud > Contacts (on)
 *   Go to iCloud.com > Contacts > Select All > Export vCard
 *
 * Or use any other method that produces a .vcf file.
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const __project_root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DB_PATH = path.join(__project_root, "store", "whatsapp.db");
const CONTACTS_DIR = path.join(__project_root, "contacts");
const DEFAULT_VCF = path.join(CONTACTS_DIR, "contacts.vcf");

// ─── VCF Parser ─────────────────────────────────────────────────────

interface ParsedContact {
  name: string;
  phones: string[];
}

function parseVcf(content: string): ParsedContact[] {
  const contacts: ParsedContact[] = [];
  const cards = content.split("BEGIN:VCARD");

  for (const card of cards) {
    if (!card.includes("END:VCARD")) continue;

    // Extract name: try FN first (formatted name), then N (structured name)
    let name: string | null = null;

    const fnMatch = card.match(/^FN[;:](.+)$/m);
    if (fnMatch) {
      name = fnMatch[1].trim();
    }

    if (!name) {
      const nMatch = card.match(/^N[;:](.+)$/m);
      if (nMatch) {
        // N field format: Last;First;Middle;Prefix;Suffix
        const parts = nMatch[1].split(";").map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          name = `${parts[1]} ${parts[0]}`; // First Last
        } else if (parts.length === 1) {
          name = parts[0];
        }
      }
    }

    if (!name) continue;

    // Extract phone numbers — handle multi-line folded values
    const phones: string[] = [];
    // Unfold continuation lines (RFC 2425: line starting with space/tab continues previous)
    const unfolded = card.replace(/\r?\n[ \t]/g, "");
    const telMatches = unfolded.matchAll(/^TEL[^:]*:(.+)$/gm);
    for (const match of telMatches) {
      const raw = match[1].trim();
      // Strip non-digit except leading +
      const cleaned = raw.replace(/[^\d+]/g, "");
      if (cleaned.length >= 7) {
        phones.push(cleaned);
      }
    }

    if (phones.length > 0) {
      contacts.push({ name, phones });
    }
  }

  return contacts;
}

// ─── Phone Number Normalization ─────────────────────────────────────

/**
 * Normalize a phone number to a WhatsApp JID.
 * Strips leading +, leading 00, and handles common formats.
 */
function phoneToJid(phone: string): string {
  let digits = phone.replace(/\D/g, "");

  // Strip leading 00 (international prefix)
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  // Strip leading 0 only if it looks like a local number with country code context
  // (we can't know the country code without more context, so we leave it)

  return `${digits}@s.whatsapp.net`;
}

// ─── Core Import Logic ──────────────────────────────────────────────

export interface ImportResult {
  success: boolean;
  vcfPath: string;
  totalParsed: number;
  exactMatches: number;
  fuzzyMatches: number;
  totalUpdated: number;
  namelessChatsRemaining: number;
}

/**
 * Import contacts from a VCF file into the database.
 * Can be called from the MCP tool or standalone CLI.
 *
 * @param dbInstance - An open better-sqlite3 database instance.
 *   When called from the MCP server, pass the shared DB.
 *   When called from CLI, opens its own connection.
 * @param vcfPath - Path to the .vcf file. Defaults to contacts/contacts.vcf.
 */
export function importContactsFromVcf(dbInstance: Database.Database, vcfPath?: string): ImportResult {
  const absPath = path.resolve(vcfPath || DEFAULT_VCF);

  // Containment check: VCF path must be inside the allowed contacts directory
  const allowedBase = path.resolve(process.env.CONTACTS_DIR || CONTACTS_DIR);
  const allowedPrefix = `${allowedBase}${path.sep}`;
  if (!absPath.startsWith(allowedPrefix)) {
    throw new Error(`VCF path not allowed: must be within ${allowedBase}`);
  }

  if (!fs.existsSync(absPath)) {
    throw new Error(`VCF file not found: ${absPath}`);
  }

  // Parse VCF
  const content = fs.readFileSync(absPath, "utf-8");
  const contacts = parseVcf(content);

  // Build lookup maps for all known JIDs (from chats and contacts tables)
  const knownJids = new Set<string>();
  const chatRows = dbInstance.prepare("SELECT jid FROM chats WHERE jid LIKE '%@s.whatsapp.net'").all() as { jid: string }[];
  const contactRows = dbInstance.prepare("SELECT jid FROM contacts WHERE jid LIKE '%@s.whatsapp.net'").all() as { jid: string }[];
  for (const row of chatRows) knownJids.add(row.jid);
  for (const row of contactRows) knownJids.add(row.jid);

  // Build a suffix map for fuzzy matching: last 9 digits → JID
  // 9 digits is long enough to avoid collisions but catches local-vs-international mismatches
  const SUFFIX_LEN = 9;
  const suffixMap = new Map<string, string[]>();
  for (const jid of knownJids) {
    const digits = jid.replace("@s.whatsapp.net", "");
    if (digits.length >= SUFFIX_LEN) {
      const suffix = digits.slice(-SUFFIX_LEN);
      if (!suffixMap.has(suffix)) suffixMap.set(suffix, []);
      suffixMap.get(suffix)!.push(jid);
    }
  }

  // Prepare statements
  const upsertContact = dbInstance.prepare(`
    INSERT INTO contacts (jid, name, notify)
    VALUES (@jid, @name, NULL)
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(@name, contacts.name)
  `);

  const upsertChat = dbInstance.prepare(`
    INSERT INTO chats (jid, name, conversation_ts, unread_count)
    VALUES (@jid, @name, 0, 0)
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(@name, chats.name)
  `);

  // Match and update — exact matches first, then fuzzy suffix matches
  let exactMatches = 0;
  let fuzzyMatches = 0;
  const matchedJids = new Set<string>(); // prevent duplicate updates for same JID

  const runImport = dbInstance.transaction(() => {
    for (const contact of contacts) {
      for (const phone of contact.phones) {
        const jid = phoneToJid(phone);

        // Exact match
        if (knownJids.has(jid) && !matchedJids.has(jid)) {
          exactMatches++;
          matchedJids.add(jid);
          upsertContact.run({ jid, name: contact.name });
          upsertChat.run({ jid, name: contact.name });
          continue;
        }

        // Fuzzy suffix match (last 9 digits)
        const digits = phone.replace(/\D/g, "");
        if (digits.length >= SUFFIX_LEN) {
          const suffix = digits.slice(-SUFFIX_LEN);
          const candidates = suffixMap.get(suffix);
          if (candidates) {
            for (const candidateJid of candidates) {
              if (matchedJids.has(candidateJid)) continue;
              fuzzyMatches++;
              matchedJids.add(candidateJid);
              upsertContact.run({ jid: candidateJid, name: contact.name });
              upsertChat.run({ jid: candidateJid, name: contact.name });
            }
          }
        }
      }
    }
  });

  runImport();

  const nameless = dbInstance.prepare(`
    SELECT COUNT(*) AS cnt FROM chats
    WHERE name IS NULL AND jid LIKE '%@s.whatsapp.net' AND conversation_ts > 0
  `).get() as { cnt: number };

  return {
    success: true,
    vcfPath: absPath,
    totalParsed: contacts.length,
    exactMatches,
    fuzzyMatches,
    totalUpdated: exactMatches + fuzzyMatches,
    namelessChatsRemaining: nameless.cnt,
  };
}

// ─── CLI Entry Point ────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const vcfPath = args.find((a) => !a.startsWith("--"));

  if (!vcfPath) {
    console.error("Usage: npx tsx src/import-contacts.ts <contacts.vcf> [--dry-run]");
    console.error("");
    console.error("Export contacts from iPhone:");
    console.error("  iCloud.com > Contacts > Select All > Export vCard");
    process.exit(1);
  }

  const absPath = path.resolve(vcfPath);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found: ${DB_PATH}`);
    console.error("Run the WhatsApp MCP server first to create the database.");
    process.exit(1);
  }

  if (dryRun) {
    // For dry run, open our own DB and just parse + report
    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");

    const content = fs.readFileSync(absPath, "utf-8");
    const contacts = parseVcf(content);
    console.log(`Parsed ${contacts.length} contacts with phone numbers from VCF`);
    console.log("\n(Dry run — no changes made)");
    db.close();
    return;
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const result = importContactsFromVcf(db, absPath);

  console.log(`Parsed ${result.totalParsed} contacts with phone numbers from VCF`);
  console.log(`\nMatched ${result.totalUpdated} phone numbers to existing WhatsApp JIDs`);
  console.log(`  Exact matches: ${result.exactMatches}`);
  console.log(`  Fuzzy matches (last 9 digits): ${result.fuzzyMatches}`);
  console.log(`\nUpdated ${result.totalUpdated} contacts with address book names`);
  console.log(`Chats still without a name: ${result.namelessChatsRemaining}`);

  db.close();
}

// Only run CLI when executed directly (not imported)
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]).includes("import-contacts");
if (isDirectRun) {
  main();
}
