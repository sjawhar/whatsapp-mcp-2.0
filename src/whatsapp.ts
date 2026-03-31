import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  getContentType,
  initAuthCreds,
  BufferJSON,
  proto,
} from "@whiskeysockets/baileys";
import type { WASocket, AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import fs from "fs";
import path from "path";
import {
  toJid,
  fromJid,
  mimeFromExtension,
  mediaCategoryFromMime,
  validateFilePath,
  sanitizeFilename,
} from "./utils.js";
import * as db from "./db.js";
import { transcribeAudio } from "./transcribe.js";

import { AUTH_DIR, DOWNLOADS_DIR as DEFAULT_DOWNLOADS_DIR, LOCK_FILE } from "./paths.js";
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || DEFAULT_DOWNLOADS_DIR;
const parsedMaxReconnectAttempts = Number(process.env.MAX_RECONNECT_ATTEMPTS || "10");
const MAX_RECONNECT_ATTEMPTS = Number.isFinite(parsedMaxReconnectAttempts) && parsedMaxReconnectAttempts > 0
  ? Math.floor(parsedMaxReconnectAttempts)
  : 10;
const parsedZombieTimeoutMs = Number(process.env.ZOMBIE_TIMEOUT_MS || "120000");
const ZOMBIE_TIMEOUT_MS = Number.isFinite(parsedZombieTimeoutMs) && parsedZombieTimeoutMs > 0
  ? Math.floor(parsedZombieTimeoutMs)
  : 120000;
const parsedMaxSendFailures = Number(process.env.MAX_SEND_FAILURES || "3");
const MAX_SEND_FAILURES = Number.isFinite(parsedMaxSendFailures) && parsedMaxSendFailures > 0
  ? Math.floor(parsedMaxSendFailures)
  : 3;

const parsedMinSendInterval = Number(process.env.MIN_SEND_INTERVAL_MS || "3000");
const MIN_SEND_INTERVAL_MS = Number.isFinite(parsedMinSendInterval) && parsedMinSendInterval >= 0
  ? Math.floor(parsedMinSendInterval)
  : 3000;
const parsedSendJitter = Number(process.env.SEND_JITTER_MS || "2000");
const SEND_JITTER_MS = Number.isFinite(parsedSendJitter) && parsedSendJitter >= 0
  ? Math.floor(parsedSendJitter)
  : 2000;

export class SendRateLimiter {
  private lastSendTimestamp = 0;
  private readonly minInterval: number;
  private readonly jitterMs: number;

  constructor(minInterval: number, jitterMs: number) {
    this.minInterval = minInterval;
    this.jitterMs = jitterMs;
  }

  async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastSendTimestamp;
    const jitter = Math.random() * this.jitterMs;
    const delay = Math.max(0, this.minInterval - elapsed) + jitter;
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    this.lastSendTimestamp = Date.now();
  }
}

const sendRateLimiter = new SendRateLimiter(MIN_SEND_INTERVAL_MS, SEND_JITTER_MS);

const PRE_KEY_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const PRE_KEY_MAX_FILES = 500;
const PRE_KEY_KEEP_FILES = 100;

const logger = pino(
  { level: "warn" },
  pino.destination({ dest: 2, sync: false })
);

// ─── Atomic Multi-File Auth State ───────────────────────────────────
// Custom replacement for Baileys' useMultiFileAuthState that uses atomic
// writes (write-to-temp + rename) to prevent JSON corruption from
// concurrent writes during app state sync. The built-in implementation
// uses plain writeFile which can produce corrupted files when two events
// write to the same key file in quick succession.

let pendingWrites = new Set<Promise<void>>();

function trackWrite(p: Promise<void>): Promise<void> {
  pendingWrites.add(p);
  p.finally(() => pendingWrites.delete(p));
  return p;
}

async function flushPendingWrites(): Promise<void> {
  if (pendingWrites.size > 0) {
    console.error(`Flushing ${pendingWrites.size} pending auth write(s)...`);
    await Promise.allSettled([...pendingWrites]);
  }
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpPath = filePath + '.tmp.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2);
  await fs.promises.writeFile(tmpPath, data);
  await fs.promises.rename(tmpPath, filePath);
}

async function useAtomicMultiFileAuthState(folder: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  await fs.promises.mkdir(folder, { recursive: true });

  const writeData = async (data: any, file: string): Promise<void> => {
    const filePath = path.join(folder, sanitizeFilename(file));
    await atomicWrite(filePath, JSON.stringify(data, BufferJSON.replacer));
  };

  const readData = async (file: string): Promise<any> => {
    try {
      const filePath = path.join(folder, sanitizeFilename(file));
      const raw = await fs.promises.readFile(filePath, { encoding: "utf-8" });
      return JSON.parse(raw, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = async (file: string): Promise<void> => {
    try {
      await fs.promises.unlink(path.join(folder, sanitizeFilename(file)));
    } catch {}
  };

  const creds: AuthenticationCreds = (await readData("creds.json")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              if (value) {
                data[id] = value;
              }
            })
          );
          return data;
        },
        set: async (data: any) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, "creds.json"),
  };
}

// ─── Connection State ───────────────────────────────────────────────

let sock: WASocket | null = null;
let connectionReady: Promise<void>;
let resolveConnection: () => void;
let rejectConnection: (err: Error) => void;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let zombieWatchdog: ReturnType<typeof setInterval> | null = null;
let lastConnectionActivity = Date.now();
let consecutiveSendFailures = 0;
let preKeyPruneInterval: ReturnType<typeof setInterval> | null = null;
let resolveContactsInterval: ReturnType<typeof setInterval> | null = null;
let resolveContactsInProgress = false;
let messageNotificationHandler: (() => void) | undefined;

export function setMessageNotificationHandler(callback: (() => void) | undefined): void {
  messageNotificationHandler = callback;
}

// ─── User Identity ──────────────────────────────────────────────────

let myJid: string | null = null;
let myName: string | null = null;
let myLidJid: string | null = null;

export function getMyInfo(): { jid: string | null; lidJid: string | null; name: string | null; phone: string | null } {
  // Try live data first
  if (myJid) {
    const normalizedJid = myJid.replace(/:\d+@/, "@");
    return {
      jid: normalizedJid,
      lidJid: myLidJid,
      name: myName || "You",
      phone: normalizedJid ? fromJid(normalizedJid) : null,
    };
  }

  // Fall back to cached profile when socket is null (read-only mode)
  const cached = db.getUserProfile();
  if (cached) {
    return {
      jid: cached.jid,
      lidJid: cached.lid_jid,
      name: cached.name || "You",
      phone: cached.jid ? fromJid(cached.jid) : null,
    };
  }

  // No live socket and no cache
  return {
    jid: null,
    lidJid: null,
    name: null,
    phone: null,
  };
}

// Auto-resolve wrapper with concurrent execution guard
async function autoResolveContacts(): Promise<void> {
  if (resolveContactsInProgress) {
    return;
  }
  resolveContactsInProgress = true;
  try {
    await resolveUnknownContacts(false);
  } catch (err) {
    console.error('Auto-resolve contacts failed:', err);
  } finally {
    resolveContactsInProgress = false;
  }
}

export async function resolveUnknownContacts(resync: boolean = false): Promise<{
  resolved: number;
  alreadyMapped: number;
  stillUnresolved: number;
  total: number;
}> {
  await connectionReady;
  if (!sock) throw new Error(getReadOnlyErrorMessage(LOCK_FILE));

  // Step 1: Trigger app state resync to get fresh contacts + LID mappings
  if (resync) {
    try {
      console.error('Triggering app state resync...');
      await sock.resyncAppState(['regular_high', 'regular_low'], false);
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (err) {
      console.error('App state resync failed:', err);
    }
  }

  // Step 2: Resolve unmapped LIDs via Baileys' LID mapping store
  const unmappedLids = db.getUnmappedLidJids();
  let resolved = 0;
  let failed = 0;

  for (const lid of unmappedLids) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(lid);
      if (pn) {
        db.saveJidMapping(lid, pn);
        // Cross-populate contact name
        const lidName = db.getContactName(lid);
        if (lidName) {
          db.upsertContact(pn, lidName, null);
          db.upsertChat(pn, lidName, null, null);
        }
        resolved++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  // Step 3: Cross-populate names for already-mapped LIDs
  const allLidChats = db.getDb().prepare(`
    SELECT DISTINCT jid FROM chats WHERE jid LIKE '%@lid'
    UNION
    SELECT DISTINCT jid FROM contacts WHERE jid LIKE '%@lid'
  `).all() as { jid: string }[];

  let namesCrossPopulated = 0;
  let alreadyMapped = 0;
  for (const { jid } of allLidChats) {
    const phoneJid = db.getPhoneJid(jid);
    if (phoneJid) {
      alreadyMapped++;
      const lidName = db.getContactName(jid);
      const phoneName = db.getContactName(phoneJid);
      if (lidName && !phoneName) {
        db.upsertContact(phoneJid, lidName, null);
        db.upsertChat(phoneJid, lidName, null, null);
        namesCrossPopulated++;
      } else if (phoneName && !lidName) {
        db.upsertContact(jid, phoneName, null);
        db.upsertChat(jid, phoneName, null, null);
        namesCrossPopulated++;
      }
    }
  }

  return {
    resolved,
    alreadyMapped: alreadyMapped + resolved,
    stillUnresolved: failed,
    total: unmappedLids.length,
  };
}

function resetConnectionPromise() {
  connectionReady = new Promise<void>((resolve, reject) => {
    resolveConnection = resolve;
    rejectConnection = reject;
  });
}

function scheduleReconnect(delayMs: number): void {
  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.error(
      `Fatal: reached MAX_RECONNECT_ATTEMPTS (${MAX_RECONNECT_ATTEMPTS}). ` +
      "Stopping reconnect attempts."
    );
    return;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  console.error(`Reconnecting in ${delayMs / 1000}s (attempt ${reconnectAttempts})...`);
  resetConnectionPromise();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void initWhatsApp();
  }, delayMs);
}

function clearZombieWatchdog(): void {
  if (!zombieWatchdog) return;
  clearInterval(zombieWatchdog);
  zombieWatchdog = null;
}

function startZombieWatchdog(currentSock: WASocket): void {
  clearZombieWatchdog();
  const checkIntervalMs = Math.max(1000, Math.min(10000, ZOMBIE_TIMEOUT_MS));
  zombieWatchdog = setInterval(() => {
    if (!sock || sock !== currentSock) return;
    if (Date.now() - lastConnectionActivity < ZOMBIE_TIMEOUT_MS) return;

    clearZombieWatchdog();
    currentSock.end(new Error("Zombie connection detected"));
  }, checkIntervalMs);
}

async function sendMessageWithHealthCheck(
  currentSock: WASocket,
  jid: string,
  messageContent: Parameters<WASocket["sendMessage"]>[1]
): Promise<Awaited<ReturnType<WASocket["sendMessage"]>>> {
  await sendRateLimiter.throttle();
  try {
    const result = await currentSock.sendMessage(jid, messageContent as any);
    consecutiveSendFailures = 0;
    return result;
  } catch (err) {
    consecutiveSendFailures++;
    if (consecutiveSendFailures >= MAX_SEND_FAILURES) {
      currentSock.end(new Error("Send health check failed"));
    }
    throw err;
  }
}

export async function clearAuthState(): Promise<void> {
  try {
    const entries = await fs.promises.readdir(AUTH_DIR);
    await Promise.all(
      entries.map((entry) =>
        fs.promises.rm(path.join(AUTH_DIR, entry), { recursive: true, force: true })
      )
    );
  } catch (err: any) {
    if (err?.code === "ENOENT") return;
    console.error("Failed to clear auth state:", err);
  }
}

async function prunePreKeys(authDir: string): Promise<void> {
  const files = await fs.promises.readdir(authDir).catch(() => [] as string[]);
  const preKeyFiles = files.filter(f => f.startsWith('pre-key-') || f.startsWith('sender-key-') || f.startsWith('session-'));
  if (preKeyFiles.length > PRE_KEY_MAX_FILES) {
    const withStats = await Promise.all(
      preKeyFiles.map(async f => ({
        f,
        mtime: (await fs.promises.stat(path.join(authDir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
      }))
    );
    withStats.sort((a, b) => a.mtime - b.mtime);
    const toDelete = withStats.slice(0, withStats.length - PRE_KEY_KEEP_FILES);
    await Promise.all(toDelete.map(({ f }) => fs.promises.unlink(path.join(authDir, f)).catch(() => {})));
    console.error(`Pruned ${toDelete.length} pre-key/session files (${preKeyFiles.length} -> ${PRE_KEY_KEEP_FILES})`);
  }
}

export function getReconnectAttempts(): number {
  return reconnectAttempts;
}

export async function handleDisconnect(statusCode: number | undefined, currentSock: WASocket | null): Promise<void> {
  const socketState = currentSock ? "socket-present" : "socket-missing";
  console.error(`Connection closed. Status: ${statusCode}. Context: ${socketState}`);

  switch (statusCode) {
    case DisconnectReason.loggedOut: {
      await clearAuthState();
      console.error("WhatsApp logged out. re-scan QR required.");
      rejectConnection(new Error("Logged out from WhatsApp. re-scan QR required."));
      return;
    }
    case DisconnectReason.forbidden: {
      console.error("Disconnect forbidden (403). Reconnect disabled.");
      rejectConnection(new Error("WhatsApp connection forbidden (403)."));
      return;
    }
    case DisconnectReason.multideviceMismatch: {
      console.error("Multi-device mismatch (411). Please update Baileys.");
      rejectConnection(new Error("Multi-device mismatch (411). update Baileys."));
      return;
    }
    case DisconnectReason.connectionLost:
    case DisconnectReason.connectionClosed:
    case DisconnectReason.unavailableService: {
      const delay = Math.min(1000 * 2 ** (reconnectAttempts + 1), 30000);
      scheduleReconnect(delay);
      return;
    }
    case DisconnectReason.connectionReplaced: {
      console.error(
        "Connection replaced by another session. " +
        "If this keeps happening, delete auth_info/ and re-scan the QR code."
      );
      const rejectCurrentConnection = rejectConnection;
      resetConnectionPromise();
      rejectCurrentConnection(new Error("Connection replaced by another session."));
      const delay = Math.min(10000 * 2 ** reconnectAttempts, 30000);
      scheduleReconnect(delay);
      return;
    }
    case DisconnectReason.badSession: {
      await clearAuthState();
      console.error("Bad session (500). Clearing auth state and reconnecting.");
      const delay = Math.min(1000 * 2 ** (reconnectAttempts + 1), 30000);
      scheduleReconnect(delay);
      return;
    }
    case DisconnectReason.restartRequired: {
      scheduleReconnect(0);
      return;
    }
    default: {
      console.error(`Unknown disconnect code: ${statusCode}. Reconnecting with backoff.`);
      const delay = Math.min(1000 * 2 ** (reconnectAttempts + 1), 30000);
      scheduleReconnect(delay);
      return;
    }
  }
}

resetConnectionPromise();

/**
 * Mark connection as ready without connecting to WhatsApp.
 * Used when another instance owns the connection and this one reads from SQLite only.
 */
export function resolveConnectionAsReadOnly(): void {
  resolveConnection();
}

/**
 * Initialize the Baileys WhatsApp client.
 * QR codes are printed to stderr so they don't interfere with MCP stdio.
 */
export async function initWhatsApp(): Promise<void> {
  clearZombieWatchdog();

  // Prune stale pre-key/session files on startup
  await prunePreKeys(AUTH_DIR);

  // Schedule periodic pre-key pruning (every 6 hours)
  if (!preKeyPruneInterval) {
    preKeyPruneInterval = setInterval(() => void prunePreKeys(AUTH_DIR), PRE_KEY_PRUNE_INTERVAL_MS);
  }

  if (sock) {
    await flushPendingWrites();
    (sock.ev as any).removeAllListeners();
    sock.end(undefined);
    sock = null;
  }

  const { state, saveCreds } = await useAtomicMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  // Only request full history sync on first pairing (when no creds exist yet).
  // On reconnections, history won't be sent by WhatsApp anyway, and requesting
  // it causes Baileys to enter AwaitingInitialSync for 20s before timing out —
  // which leads to 408 disconnects and an endless reconnect loop.
  const isFirstPairing = !state.creds.registered;

  // Wrap keys.set so every auth-state write is tracked and can be awaited
  // before socket close — preventing stale session files on disk.
  const originalKeysSet = state.keys.set.bind(state.keys);
  state.keys.set = (data: Parameters<typeof originalKeysSet>[0]) => {
    const result = originalKeysSet(data);
    // keys.set returns Awaitable<void> — may be sync or async
    if (result && typeof (result as any).then === "function") {
      const p = (result as Promise<void>).catch((err: Error) => {
        console.error("Auth key write failed:", err);
      });
      return trackWrite(p);
    }
    return result;
  };

  const trackedSaveCreds = () => trackWrite(saveCreds());

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["WhatsApp MCP", "Chrome", "1.0.0"],
    generateHighQualityLinkPreview: false,
    syncFullHistory: isFirstPairing,
    shouldSyncHistoryMessage: () => isFirstPairing,
    keepAliveIntervalMs: 25_000,
    markOnlineOnConnect: false,
  });

  lastConnectionActivity = Date.now();
  consecutiveSendFailures = 0;
  startZombieWatchdog(sock);

  // ─── Bind events ──────────────────────────────────────────
  //
  // CRITICAL: We must use sock.ev.process() instead of individual sock.ev.on()
  // listeners. Baileys buffers events during history sync and flushes them as a
  // consolidated map via the internal 'event' emitter. Individual .on() listeners
  // only receive unbuffered events and will MISS the entire history sync payload.
  // sock.ev.process() is the correct API that receives both buffered and unbuffered events.

  sock.ev.on("creds.update", trackedSaveCreds);

  sock.ev.process(async (events) => {
    // ─── Connection Updates ─────────────────────────────────
    if (events["connection.update"]) {
      lastConnectionActivity = Date.now();
      const { connection, lastDisconnect, qr } = events["connection.update"];

      if (qr) {
        console.error("\n=== Scan this QR code in WhatsApp ===");
        console.error("Link a device > QR code\n");
        printQrToStderr(qr);
      }

      if (connection === "close") {
        clearZombieWatchdog();
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        await handleDisconnect(statusCode, sock);
      }

      if (connection === "open") {
        console.error("WhatsApp connected successfully!");
        reconnectAttempts = 0;
        lastConnectionActivity = Date.now();
        consecutiveSendFailures = 0;

        if (sock?.user) {
          myJid = sock.user.id;
          myName = sock.user.name || null;
          myLidJid = (sock.user as any).lid || null;
          // Normalize JID: strip device suffix (e.g. "971525527198:5@s.whatsapp.net" → "971525527198@s.whatsapp.net")
          const normalizedJid = myJid.replace(/:\d+@/, "@");
          const displayName = myName || "You";
          console.error(`Authenticated as: ${displayName} (${normalizedJid}${myLidJid ? `, LID: ${myLidJid}` : ""})`);
          // Store our own identity so our chat shows a name, not a number
          db.upsertContact(normalizedJid, displayName, myName);
          db.upsertChat(normalizedJid, displayName, null, null);
          // Store LID ↔ phone mapping for our own account
          if (myLidJid) {
            db.saveJidMapping(myLidJid, normalizedJid);
            db.upsertContact(myLidJid, displayName, myName);
            db.upsertChat(myLidJid, displayName, null, null);
          }
          // Cache user profile for read-only mode fallback
          db.upsertUserProfile(normalizedJid, myLidJid, displayName);
        }

        console.error("Connection ready");
        resolveConnection();
        // Fire auto-resolve contacts (fire-and-forget)
        void autoResolveContacts().catch(err => console.error('Auto-resolve failed:', err));

        // Set up periodic auto-resolve (every 30 minutes)
        if (!resolveContactsInterval) {
          resolveContactsInterval = setInterval(() => void autoResolveContacts().catch(err => console.error('Auto-resolve failed:', err)), 30 * 60 * 1000);
        }
      }
    }

    // ─── History Sync (bulk load after QR scan) ─────────────
    if (events["messaging-history.set"]) {
      const { chats: syncChats, contacts: syncContacts, messages: syncMessages } = events["messaging-history.set"];
      const progress = (events["messaging-history.set"] as any).progress;
      const syncType = (events["messaging-history.set"] as any).syncType;

      console.error(`History sync: ${syncChats.length} chats, ${syncContacts.length} contacts, ${syncMessages.length} messages (type=${syncType} progress=${progress ?? "?"}%)`);

      db.upsertChats(syncChats as any[]);
      db.upsertContacts(syncContacts as any[]);

      // Propagate contact names (push names) to the chats table so chat
      // listings show names immediately. The push_name sync (type 4)
      // delivers ~1000 contacts with notify fields — without this step
      // those names only exist in the contacts table and require a JOIN.
      // Also extract LID ↔ phone JID mappings from synced contacts.
      for (const contact of syncContacts as any[]) {
        const displayName = contact.name || contact.notify || contact.verifiedName;
        if (displayName && contact.id) {
          db.upsertChat(contact.id, displayName, null, null);
        }
        // Extract LID ↔ phone mapping
        const cLid = contact.lid || (contact.id?.endsWith?.("@lid") ? contact.id : null);
        const cPhone = contact.jid || (contact.id?.endsWith?.("@s.whatsapp.net") ? contact.id : null);
        if (cLid && cPhone) {
          db.saveJidMapping(cLid, cPhone);
        }
      }

      // Group messages by chat JID and batch-insert
      const byJid = new Map<string, any[]>();
      for (const msg of syncMessages) {
        const jid = msg.key.remoteJid;
        if (!jid) continue;
        if (!byJid.has(jid)) byJid.set(jid, []);
        byJid.get(jid)!.push(msg);
      }
      for (const [jid, msgs] of byJid) {
        db.upsertMessages(jid, msgs);
        if (msgs.length > 0) {
          const latest = msgs[msgs.length - 1];
          db.upsertChat(jid, null, Number(latest.messageTimestamp || 0), 0);
        }
      }
    }

    // ─── Chat Events ────────────────────────────────────────
    if (events["chats.upsert"]) {
      db.upsertChats(events["chats.upsert"] as any[]);
    }

    if (events["chats.update"]) {
      for (const update of events["chats.update"]) {
        if (!update.id) continue;
        db.upsertChat(update.id, (update as any).name, (update as any).conversationTimestamp ? Number((update as any).conversationTimestamp) : null, (update as any).unreadCount);
      }
    }

    if (events["chats.delete"]) {
      for (const id of events["chats.delete"]) {
        db.deleteChat(id);
      }
    }

    // ─── LID ↔ Phone JID Mapping ────────────────────────────
    if (events["lid-mapping.update"]) {
      const { lid, pn } = events["lid-mapping.update"];
      if (lid && pn) {
        db.saveJidMapping(lid, pn);
      }
    }

    // ─── Contact Events ─────────────────────────────────────
    if (events["contacts.upsert"]) {
      const contacts = events["contacts.upsert"];
      db.upsertContacts(contacts as any[]);
      for (const contact of contacts) {
        const name = contact.name || contact.notify;
        if (name) {
          // Store under the primary id
          db.upsertChat(contact.id, name, null, null);
          // ContactAction from app state sync may use LID as id but provide
          // the phone-number JID in the jid field — store under that too
          const phoneJid = (contact as any).jid;
          if (phoneJid && phoneJid !== contact.id) {
            db.upsertContact(phoneJid, contact.name || null, contact.notify || null);
            db.upsertChat(phoneJid, name, null, null);
          }
        }

        // Extract LID ↔ phone JID mapping from Contact object.
        // Baileys Contact type has: id (primary), lid? (@lid), jid? (@s.whatsapp.net)
        const cLid = (contact as any).lid || (contact.id.endsWith("@lid") ? contact.id : null);
        const cPhone = (contact as any).jid || (contact.id.endsWith("@s.whatsapp.net") ? contact.id : null);
        if (cLid && cPhone) {
          db.saveJidMapping(cLid, cPhone);
        }
      }
    }

    if (events["contacts.update"]) {
      for (const update of events["contacts.update"]) {
        if (!update.id) continue;
        db.upsertContact(update.id, (update as any).name, (update as any).notify);
        const updatedName = (update as any).name || (update as any).notify;
        if (updatedName) {
          db.upsertChat(update.id, updatedName, null, null);
        }
      }
    }

    // ─── Message Events ─────────────────────────────────────
    if (events["messages.upsert"]) {
      const { messages: newMsgs } = events["messages.upsert"];
      for (const msg of newMsgs) {
        const jid = msg.key.remoteJid;
        if (!jid) continue;

        // pushName is the sender's WhatsApp display name — use it to populate contacts
        const pushName = (msg as any).pushName;
        const senderJid = msg.key.fromMe ? null : (msg.key.participant || jid);
        if (pushName && senderJid) {
          db.upsertContact(senderJid, null, pushName);
        }

        db.upsertMessage(jid, msg);
        const msgTs = Number(msg.messageTimestamp || 0);
        const chatName = (!msg.key.fromMe && !jid.endsWith("@g.us") && pushName) ? pushName : null;
        db.upsertChat(jid, chatName, msgTs, msg.key.fromMe ? null : undefined);
      }

      if (newMsgs.length > 0) {
        messageNotificationHandler?.();
      }
    }

    if (events["messages.update"]) {
      for (const { key, update } of events["messages.update"]) {
        const jid = key.remoteJid;
        if (!jid || !key.id) continue;
        const merged = { key, message: (update as any).message, messageTimestamp: (update as any).messageTimestamp, participant: (update as any).participant };
        if (merged.message) {
          db.upsertMessage(jid, merged as any);
        }
      }
    }
  });
}

/**
 * Cleanly close the WhatsApp connection.
 */
export async function closeWhatsApp(): Promise<void> {
  clearZombieWatchdog();

  if (preKeyPruneInterval) {
    clearInterval(preKeyPruneInterval);
    preKeyPruneInterval = null;
  }
  if (resolveContactsInterval) {
    clearInterval(resolveContactsInterval);
    resolveContactsInterval = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (sock) {
    await flushPendingWrites();
    (sock.ev as any).removeAllListeners();
    sock.end(undefined);
    sock = null;
  }
}

/**
 * Resolve a chat name. For groups without a name, fetch metadata from WhatsApp.
 * Like the Go project's GetChatName — resolve inline when needed.
 */
export async function resolveChatName(jid: string): Promise<string | null> {
  // Check if we already have a name in the DB
  const existing = db.getChatName(jid);
  if (existing) return existing;

  // For groups, try fetching metadata
  if (jid.endsWith("@g.us") && sock) {
    try {
      const meta = await sock.groupMetadata(jid);
      if (meta.subject) {
        db.upsertChat(jid, meta.subject, null, null);
        return meta.subject;
      }
    } catch {
      // Group may no longer exist or we're not a member
    }
  }

  // For individual chats, try contact store
  if (jid.endsWith("@s.whatsapp.net")) {
    const contact = db.getContactName(jid);
    if (contact) {
      db.upsertChat(jid, contact, null, null);
      return contact;
    }
  }

  return null;
}
/**
 * Generate a read-only mode error message with PID info if available.
 * Reads the lock file to extract the PID of the process holding the connection.
 * Falls back gracefully if the lock file can't be read.
 */
export function getReadOnlyErrorMessage(lockFilePath: string): string {
  try {
    const pid = parseInt(fs.readFileSync(lockFilePath, "utf-8").trim(), 10);
    if (!Number.isNaN(pid)) {
      return `Running in read-only mode — another process (PID ${pid}) holds the WhatsApp connection. This will auto-recover within 10 seconds if that process dies.`;
    }
  } catch {
    // Lock file missing, unreadable, or PID not a number — fall through to generic message
  }
  return "Running in read-only mode — another process holds the WhatsApp connection. This will auto-recover within 10 seconds if that process dies.";
}


async function getSocket(): Promise<WASocket> {
  // During reconnection cycles, sock may be momentarily null while a new
  // socket is being created. Re-await connectionReady to wait for it.
  if (!sock) {
    await connectionReady;
  }
  if (!sock) throw new Error(getReadOnlyErrorMessage(LOCK_FILE));
  return sock;
}

/**
 * Return the socket if available, or null if running in read-only mode.
 * Used by media download functions that can work without a socket —
 * the socket is only needed as a fallback to re-upload expired CDN URLs.
 */
function getSocketOrNull(): WASocket | null {
  return sock;
}

// ─── Reading Functions ──────────────────────────────────────────────

export async function getChats(nameFilter?: string, limit?: number): Promise<Record<string, unknown>[]> {
  await connectionReady;
  const chats = db.getChats(nameFilter, limit);

  // Resolve names for any chats missing them (like the Go project does inline)
  for (const chat of chats) {
    if (!chat.name && typeof chat.jid === "string") {
      const name = await resolveChatName(chat.jid);
      if (name) chat.name = name;
    }
  }

  return chats;
}

export async function getChat(jid: string): Promise<Record<string, unknown>> {
  await connectionReady;
  const normalJid = toJid(jid);
  const chat = db.getChat(normalJid);

  // Resolve name if missing
  if (chat && !chat.name) {
    const name = await resolveChatName(normalJid);
    if (name) chat.name = name;
  }

  return chat;
}

export async function getMessages(jid: string, limit: number = 50): Promise<Record<string, unknown>[]> {
  await connectionReady;
  return db.getMessages(toJid(jid), limit);
}

export async function searchMessages(query: string, jid?: string): Promise<Record<string, unknown>[]> {
  await connectionReady;
  return db.searchMessages(query, jid ? toJid(jid) : undefined);
}

export async function searchContacts(query: string): Promise<Record<string, unknown>[]> {
  await connectionReady;
  return db.searchContacts(query);
}

export async function getMessageContext(jid: string, messageId: string, count: number = 5): Promise<Record<string, unknown>> {
  await connectionReady;
  return db.getMessageContext(toJid(jid), messageId, count);
}

// ─── Contact Management ─────────────────────────────────────────────

export async function updateContact(jid: string, name: string): Promise<Record<string, unknown>> {
  const normalJid = toJid(jid);
  db.upsertContact(normalJid, name, null);
  db.upsertChat(normalJid, name, null, null);
  return { success: true, jid: normalJid, name };
}

// ─── Writing Functions ──────────────────────────────────────────────

export async function deleteChat(jid: string): Promise<Record<string, unknown>> {
  await connectionReady;
  const s = await getSocket();
  const normalJid = toJid(jid);

  const lastMsg = db.getLastMessageKey(normalJid);
  if (!lastMsg) {
    throw new Error(`No messages found in chat ${normalJid} — cannot delete an empty chat.`);
  }

  try {
    await s.chatModify(
      {
        delete: true,
        lastMessages: [{
          key: {
            remoteJid: normalJid,
            fromMe: lastMsg.fromMe,
            id: lastMsg.id,
          },
          messageTimestamp: lastMsg.timestamp,
        }],
      },
      normalJid
    );
  } catch (err: any) {
    if (err.message?.includes("not present")) {
      throw new Error(
        "WhatsApp app state keys haven't synced yet. " +
        "This happens on fresh installs — wait a few minutes and try again, or restart the server."
      );
    }
    throw err;
  }

  // Clean up local database
  db.deleteChatMessages(normalJid);
  db.deleteChat(normalJid);

  return { success: true, jid: normalJid };
}

export async function deleteMessage(jid: string, messageId: string): Promise<Record<string, unknown>> {
  await connectionReady;
  const s = await getSocket();
  const normalJid = toJid(jid);

  // Look up from_me to build the correct WAMessageKey for deletion
  const fromMe = db.getMessageFromMe(normalJid, messageId);
  if (fromMe === null) {
    throw new Error(`Message ${messageId} not found in chat ${normalJid}`);
  }

  // Delete on WhatsApp servers first — if this fails, local DB stays intact
  await sendMessageWithHealthCheck(s, normalJid, {
    delete: {
      remoteJid: normalJid,
      fromMe,
      id: messageId,
    },
  });

  // Remove from local database
  db.deleteMessage(normalJid, messageId);

  return { success: true, jid: normalJid, messageId };
}

export function getRecipientInfo(jid: string): { jid: string; name: string | null; phone: string } {
  const normalJid = toJid(jid);
  const canonicalJid = db.getCanonicalJid(normalJid);
  let name = db.getContactName(canonicalJid);

  // If name not found on canonical JID, check other JID variants
  if (!name) {
    const allJids = db.getAllJidsFor(canonicalJid);
    for (const otherJid of allJids) {
      if (otherJid !== canonicalJid) {
        const otherName = db.getContactName(otherJid);
        if (otherName) {
          name = otherName;
          break;
        }
      }
    }
  }

  const phone = fromJid(canonicalJid);
  return { jid: canonicalJid, name, phone };
}


export async function sendTextMessage(jid: string, text: string, quotedMessageId?: string): Promise<Record<string, unknown>> {
  await connectionReady;
  const s = await getSocket();
  const normalJid = toJid(jid);
  const activeJid = db.getActiveJid(normalJid);

  const msgContent: any = { text };

  if (quotedMessageId) {
    const blob = db.getMessageBlob(jid, quotedMessageId);
    if (blob) {
      try {
        msgContent.quoted = JSON.parse(blob);
      } catch {
        // If blob can't be parsed, send without quote
      }
    }
  }

  const sent = await sendMessageWithHealthCheck(s, activeJid, msgContent);
  return {
    success: true,
    messageId: sent?.key.id,
    to: activeJid,
    quotedMessageId: quotedMessageId || null,
  };
}

export async function sendFileMessage(
  jid: string,
  filePath: string,
  caption?: string
): Promise<Record<string, unknown>> {
  const allowedDir = process.env.ALLOWED_SEND_DIR || "./uploads/";
  const maxFileSize = Number(process.env.MAX_SEND_FILE_SIZE || "67108864");
  const validation = validateFilePath(filePath, allowedDir, maxFileSize);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const absolutePath = validation.absolutePath;

  await connectionReady;
  const s = await getSocket();
  const normalJid = toJid(jid);
  const activeJid = db.getActiveJid(normalJid);

  const mime = mimeFromExtension(absolutePath);
  const category = mediaCategoryFromMime(mime);
  const stream = fs.createReadStream(absolutePath);
  const fileName = path.basename(absolutePath);

  let messageContent: Parameters<typeof s.sendMessage>[1];
  switch (category) {
    case "image":
      messageContent = { image: stream as any, caption, mimetype: mime };
      break;
    case "video":
      messageContent = { video: stream as any, caption, mimetype: mime };
      break;
    case "audio":
      messageContent = { audio: stream as any, mimetype: mime, ptt: false };
      break;
    default:
      messageContent = { document: stream as any, mimetype: mime, fileName, caption };
      break;
  }

  const sent = await sendMessageWithHealthCheck(s, activeJid, messageContent);
  return {
    success: true,
    messageId: sent?.key.id,
    to: activeJid,
    fileType: category,
  };
}

// ─── Media Functions ────────────────────────────────────────────────

export async function downloadMessageMedia(
  jid: string,
  messageId: string
): Promise<Record<string, unknown>> {
  await connectionReady;
  const normalJid = toJid(jid);

  const blob = db.getMessageBlob(normalJid, messageId);
  if (!blob) {
    throw new Error(`Message ${messageId} not found or has no downloadable media in chat ${normalJid}`);
  }

  const stored = JSON.parse(blob);
  if (!stored.message) {
    throw new Error("Message has no content");
  }

  const s = getSocketOrNull();
  const buffer = await downloadMediaMessage(
    stored,
    "buffer",
    {},
    s ? { logger, reuploadRequest: s.updateMediaMessage } : undefined
  );

  const contentType = getContentType(stored.message);
  const mediaMsg = stored.message[contentType!];
  const mimetype: string = mediaMsg?.mimetype || "application/octet-stream";
  const ext = extensionFromMime(mimetype);

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const fileName = `${sanitizeFilename(messageId)}.${ext}`;
  const outPath = path.join(DOWNLOADS_DIR, fileName);
  if (!path.resolve(outPath).startsWith(path.resolve(DOWNLOADS_DIR) + path.sep)) {
    throw new Error("Path traversal detected");
  }
  fs.writeFileSync(outPath, buffer as Buffer);

  return {
    success: true,
    filePath: path.resolve(outPath),
    fileName,
    mimeType: mimetype,
    type: contentType,
    size: (buffer as Buffer).length,
  };
}

export async function transcribeVoiceNote(
  jid: string,
  messageId: string
): Promise<Record<string, unknown>> {
  await connectionReady;
  const normalJid = toJid(jid);

  // Validate message type
  const msgType = db.getMessageTypeById(normalJid, messageId);
  if (!msgType) {
    throw new Error(`Message ${messageId} not found in chat ${normalJid}`);
  }
  if (msgType !== "voice_note" && msgType !== "audio") {
    throw new Error(
      `Message ${messageId} is type "${msgType}", not a voice note or audio message.`
    );
  }

  // Check cache
  const cached = db.getTranscription(normalJid, messageId);
  if (cached) {
    return {
      success: true,
      messageId,
      chatJid: normalJid,
      transcription: cached,
      cached: true,
    };
  }

  // Download audio into RAM (no disk write)
  const blob = db.getMessageBlob(normalJid, messageId);
  if (!blob) {
    throw new Error(`Message ${messageId} has no downloadable media`);
  }

  const stored = JSON.parse(blob);
  if (!stored.message) {
    throw new Error("Message has no content");
  }

  const s = getSocketOrNull();
  const buffer = await downloadMediaMessage(
    stored,
    "buffer",
    {},
    s ? { logger, reuploadRequest: s.updateMediaMessage } : undefined
  );

  const contentType = getContentType(stored.message);
  const mediaMsg = stored.message[contentType!];
  const ext = extensionFromMime(mediaMsg?.mimetype || "audio/ogg");

  // Transcribe via Whisper API
  const result = await transcribeAudio(buffer as Buffer, `${messageId}.${ext}`);

  // Cache in database
  db.saveTranscription(normalJid, messageId, result.text);

  return {
    success: true,
    messageId,
    chatJid: normalJid,
    transcription: result.text,
    language: result.language,
    duration: result.duration,
    cached: false,
  };
}

function extensionFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "audio/ogg; codecs=opus": "ogg",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  };
  return map[mime] || mime.split("/").pop()?.replace(/[^a-z0-9]/g, "") || "bin";
}

// ─── QR Code Rendering ─────────────────────────────────────────────

function printQrToStderr(qr: string) {
  // @ts-ignore - qrcode-terminal has no types
  import("qrcode-terminal").then((mod) => {
    const QRC = mod.default || mod;
    QRC.generate(qr, { small: true }, (code: string) => {
      console.error(code);
    });
  }).catch(() => {
    console.error("QR Data (copy to a QR code generator):");
    console.error(qr);
  });
}
