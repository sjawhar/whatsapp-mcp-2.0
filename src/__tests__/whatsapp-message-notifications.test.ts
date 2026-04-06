import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestDb, setupTestDb } from "./helpers/test-db.js";
import { createFakeBaileysSocket, type FakeBaileysSocket } from "./helpers/fake-baileys.js";

const mockState = vi.hoisted(() => ({
  sockets: [] as FakeBaileysSocket[],
}));

vi.mock("@whiskeysockets/baileys", () => ({
  default: vi.fn(() => {
    const socket = createFakeBaileysSocket();
    mockState.sockets.push(socket);
    return socket;
  }),
  DisconnectReason: { loggedOut: 401, connectionReplaced: 440 },
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

function latestSocket(): FakeBaileysSocket {
  const socket = mockState.sockets.at(-1);
  if (!socket) {
    throw new Error("No fake socket was created");
  }
  return socket;
}

describe("WhatsApp message notification handler", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockState.sockets.length = 0;
    await setupTestDb();
  });

  afterEach(async () => {
    const whatsapp = await import("../whatsapp.js");
    whatsapp.setMessageNotificationHandler(undefined);
    await whatsapp.closeWhatsApp();
    closeTestDb();
  });

  it("passes unique inbound chat JIDs to the notification handler", async () => {
    const whatsapp = await import("../whatsapp.js");
    const onMessages = vi.fn();

    whatsapp.setMessageNotificationHandler(onMessages);
    await whatsapp.initWhatsApp();
    latestSocket().emitConnectionOpen();

    latestSocket().emitMessagesUpsert([
      {
        key: { id: "in-1", remoteJid: "15550001111@s.whatsapp.net", fromMe: false },
        messageTimestamp: 1700001000,
        message: { conversation: "hello" },
        pushName: "Alice Test",
      },
      {
        key: { id: "in-2", remoteJid: "15550001111@s.whatsapp.net", fromMe: false },
        messageTimestamp: 1700001001,
        message: { conversation: "again" },
        pushName: "Alice Test",
      },
      {
        key: { id: "out-1", remoteJid: "15550002222@s.whatsapp.net", fromMe: true },
        messageTimestamp: 1700001002,
        message: { conversation: "sent" },
      },
    ]);

    expect(onMessages).toHaveBeenCalledWith(["15550001111@s.whatsapp.net"]);
  });

  it("does not notify for outbound-only batches", async () => {
    const whatsapp = await import("../whatsapp.js");
    const onMessages = vi.fn();

    whatsapp.setMessageNotificationHandler(onMessages);
    await whatsapp.initWhatsApp();
    latestSocket().emitConnectionOpen();

    latestSocket().emitMessagesUpsert([
      {
        key: { id: "out-1", remoteJid: "15550001111@s.whatsapp.net", fromMe: true },
        messageTimestamp: 1700001000,
        message: { conversation: "sent" },
      },
    ]);

    expect(onMessages).not.toHaveBeenCalled();
  });
});
