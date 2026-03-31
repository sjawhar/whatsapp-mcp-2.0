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

  it("should set up 30-minute interval for auto-resolve", async () => {
    // Mock resolveUnknownContacts before importing
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

  it("should clear interval on closeWhatsApp", async () => {
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

  it("should guard against concurrent resolves", async () => {
    let resolveCount = 0;
    const resolveUnknownContactsSpy = vi.spyOn(whatsapp, "resolveUnknownContacts").mockImplementation(async () => {
      resolveCount++;
      // Simulate a slow resolve that takes 500ms
      await new Promise(resolve => setTimeout(resolve, 500));
      return { resolved: 0, alreadyMapped: 0, stillUnresolved: 0, total: 0 };
    });

    await whatsapp.initWhatsApp();
    latestSocket().emitConnectionOpen();

    // Give the fire-and-forget promise a chance to execute
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(resolveCount).toBe(1);

    // Wait for the first resolve to complete
    await new Promise(resolve => setTimeout(resolve, 600));

    // The spy should have been called only once
    expect(resolveUnknownContactsSpy).toHaveBeenCalledTimes(1);

    resolveUnknownContactsSpy.mockRestore();
  });

  it("should handle errors in auto-resolve gracefully", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolveUnknownContactsSpy = vi.spyOn(whatsapp, "resolveUnknownContacts").mockRejectedValue(new Error("Test error"));

    await whatsapp.initWhatsApp();
    latestSocket().emitConnectionOpen();

    // Give the fire-and-forget promise a chance to execute
    await new Promise(resolve => setTimeout(resolve, 500));

    // Should have logged the error - check for the specific error message
    const errorCalls = consoleErrorSpy.mock.calls.filter(call => call[0] === "Auto-resolve contacts failed:");
    expect(errorCalls.length).toBeGreaterThan(0);

    consoleErrorSpy.mockRestore();
    resolveUnknownContactsSpy.mockRestore();
  });
});
