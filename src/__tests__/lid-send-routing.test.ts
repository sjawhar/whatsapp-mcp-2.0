import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeBaileysSocket, type FakeBaileysSocket } from "./helpers/fake-baileys.js";
import { closeTestDb, seedLidTestData, setupTestDb } from "./helpers/test-db.js";

const mockState = vi.hoisted(() => ({
  sockets: [] as FakeBaileysSocket[],
}));

vi.mock("@whiskeysockets/baileys", () => ({
  default: vi.fn(() => {
    const socket = createFakeBaileysSocket();
    mockState.sockets.push(socket);
    return socket;
  }),
  DisconnectReason: {
    loggedOut: 401,
    connectionReplaced: 440,
  },
  fetchLatestBaileysVersion: vi.fn(async () => ({ version: [2, 3000, 0] })),
  downloadMediaMessage: vi.fn(),
  getContentType: vi.fn(),
  initAuthCreds: vi.fn(() => ({})),
  BufferJSON: {
    replacer: (_key: string, value: unknown) => value,
    reviver: (_key: string, value: unknown) => value,
  },
  proto: {
    Message: {
      AppStateSyncKeyData: {
        fromObject: (value: unknown) => value,
      },
    },
  },
}));

describe("LID send routing", () => {
  const originalMinInterval = process.env.MIN_SEND_INTERVAL_MS;
  const originalJitter = process.env.SEND_JITTER_MS;

  let sendTextMessage: typeof import("../whatsapp.js").sendTextMessage;
  let closeWhatsApp: typeof import("../whatsapp.js").closeWhatsApp;
  let getDb: typeof import("../db.js").getDb;

  beforeAll(async () => {
    process.env.MIN_SEND_INTERVAL_MS = "0";
    process.env.SEND_JITTER_MS = "0";

    await setupTestDb();
    seedLidTestData();

    const dbMod = await import("../db.js");
    getDb = dbMod.getDb;

    const whatsapp = await import("../whatsapp.js");
    sendTextMessage = whatsapp.sendTextMessage;
    closeWhatsApp = whatsapp.closeWhatsApp;
    await whatsapp.initWhatsApp();

    const socket = mockState.sockets.at(-1);
    if (!socket) throw new Error("Expected fake Baileys socket");
    socket.emitConnectionOpen();
  });

  afterAll(async () => {
    await closeWhatsApp?.();
    closeTestDb();

    if (originalMinInterval === undefined) {
      delete process.env.MIN_SEND_INTERVAL_MS;
    } else {
      process.env.MIN_SEND_INTERVAL_MS = originalMinInterval;
    }

    if (originalJitter === undefined) {
      delete process.env.SEND_JITTER_MS;
    } else {
      process.env.SEND_JITTER_MS = originalJitter;
    }
  });

  it("routes to LID when LID has most recent messages", async () => {
    const socket = mockState.sockets.at(-1)!;
    const before = socket.sentMessages.length;

    // Input phone JID, but LID has more recent messages (timestamp 1700000110 vs 1700000050)
    const result = await sendTextMessage("50763345671@s.whatsapp.net", "Hello via phone JID");

    expect(result.success).toBe(true);
    expect(result.to).toBe("169509591765046@lid");

    const sent = socket.sentMessages[before];
    expect(sent.jid).toBe("169509591765046@lid");
    expect(sent.content).toEqual({ text: "Hello via phone JID" });
  });

  it("routes to phone JID when phone has most recent messages", async () => {
    const db = getDb();
    // Insert a very recent message under the phone JID to make it the active one
    db.prepare(
      "INSERT INTO messages (id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media, message_blob, transcription) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "phone-recent-msg",
      "50763345671@s.whatsapp.net",
      1,
      "15559990000@s.whatsapp.net",
      "Me",
      "text",
      "Very recent message",
      1700000999, // Much more recent than LID messages
      0,
      null,
      null
    );

    const socket = mockState.sockets.at(-1)!;
    const before = socket.sentMessages.length;

    const result = await sendTextMessage("50763345671@s.whatsapp.net", "Hello via phone JID again");

    expect(result.success).toBe(true);
    expect(result.to).toBe("50763345671@s.whatsapp.net");

    const sent = socket.sentMessages[before];
    expect(sent.jid).toBe("50763345671@s.whatsapp.net");
    expect(sent.content).toEqual({ text: "Hello via phone JID again" });

    // Clean up the inserted message so it doesn't affect other tests
    db.prepare("DELETE FROM messages WHERE id = ?").run("phone-recent-msg");
  });

  it("routes to input JID when no messages exist", async () => {
    const socket = mockState.sockets.at(-1)!;
    const before = socket.sentMessages.length;

    // Use an unknown JID with no messages or mapping
    const result = await sendTextMessage("19998887777@s.whatsapp.net", "Hello stranger");

    expect(result.success).toBe(true);
    expect(result.to).toBe("19998887777@s.whatsapp.net");

    const sent = socket.sentMessages[before];
    expect(sent.jid).toBe("19998887777@s.whatsapp.net");
    expect(sent.content).toEqual({ text: "Hello stranger" });
  });
});
