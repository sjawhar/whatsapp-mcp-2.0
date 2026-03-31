import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestDb, seedTestDb, setupTestDb } from "./helpers/test-db.js";
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

describe("auto-resolve contacts", () => {
  let whatsapp: typeof import("../whatsapp.js");

  beforeEach(async () => {
    vi.resetModules();
    mockState.sockets.length = 0;

    await setupTestDb();
    seedTestDb();

    whatsapp = await import("../whatsapp.js");
  });

  afterEach(async () => {
    await closeTestDb();
  });

  it("should set up 30-minute interval for auto-resolve on connection open", async () => {
    const resolveUnknownContactsSpy = vi.spyOn(whatsapp, "resolveUnknownContacts").mockResolvedValue({
      resolved: 0,
      alreadyMapped: 0,
      stillUnresolved: 0,
      total: 0,
    });

    const setIntervalSpy = vi.spyOn(global, "setInterval");

    await whatsapp.initWhatsApp();
    latestSocket().emitConnectionOpen();

    // Give the fire-and-forget promise a chance to execute
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check that setInterval was called with 30 minutes (1800000 ms)
    const intervalCall = setIntervalSpy.mock.calls.find(call => call[1] === 30 * 60 * 1000);
    expect(intervalCall).toBeDefined();
    expect(intervalCall?.[1]).toBe(30 * 60 * 1000);

    setIntervalSpy.mockRestore();
    resolveUnknownContactsSpy.mockRestore();
  });

  it("should clear resolve interval on closeWhatsApp", async () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const resolveUnknownContactsSpy = vi.spyOn(whatsapp, "resolveUnknownContacts").mockResolvedValue({
      resolved: 0,
      alreadyMapped: 0,
      stillUnresolved: 0,
      total: 0,
    });

    await whatsapp.initWhatsApp();
    latestSocket().emitConnectionOpen();

    // Give the fire-and-forget promise a chance to execute
    await new Promise(resolve => setTimeout(resolve, 500));

    // Close the connection
    await whatsapp.closeWhatsApp();

    // Check that clearInterval was called
    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
    resolveUnknownContactsSpy.mockRestore();
  });
});
