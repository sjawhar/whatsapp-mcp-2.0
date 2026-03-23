import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import { createFakeBaileysSocket, type FakeBaileysSocket } from "./helpers/fake-baileys.js";
import { closeTestDb, seedTestDb, setupTestDb } from "./helpers/test-db.js";

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
    forbidden: 403,
    connectionLost: 408,
    multideviceMismatch: 411,
    connectionClosed: 428,
    connectionReplaced: 440,
    badSession: 500,
    unavailableService: 503,
    restartRequired: 515,
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

function latestSocket(): FakeBaileysSocket {
  const socket = mockState.sockets.at(-1);
  if (!socket) {
    throw new Error("No fake socket was created");
  }
  return socket;
}

async function importWhatsAppResolved() {
  const whatsapp = await import("../whatsapp.js");
  whatsapp.resolveConnectionAsReadOnly();
  return whatsapp;
}

describe("disconnect handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mockState.sockets.length = 0;
    delete process.env.MAX_RECONNECT_ATTEMPTS;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    const whatsapp = await import("../whatsapp.js");
    await whatsapp.closeWhatsApp();
  });

  it("401 (loggedOut) does not reconnect, clears auth, and logs re-scan QR required", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readdirSpy = vi.spyOn(fs.promises, "readdir").mockResolvedValue(["creds.json"] as any);
    const rmSpy = vi.spyOn(fs.promises, "rm").mockResolvedValue(undefined);

    const whatsapp = await importWhatsAppResolved();
    await whatsapp.handleDisconnect(401, null);

    expect(vi.getTimerCount()).toBe(0);
    expect(readdirSpy).toHaveBeenCalled();
    expect(rmSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("re-scan QR required");
  });

  it("403 (forbidden) does not reconnect and logs warning", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const whatsapp = await importWhatsAppResolved();

    await whatsapp.handleDisconnect(403, null);

    expect(vi.getTimerCount()).toBe(0);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("forbidden");
  });

  it("408 (connectionLost) reconnects with backoff", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const whatsapp = await importWhatsAppResolved();

    await whatsapp.handleDisconnect(408, null);

    expect(vi.getTimerCount()).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("Reconnecting in 2s");
  });

  it("411 (multideviceMismatch) does not reconnect and logs update Baileys", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const whatsapp = await importWhatsAppResolved();

    await whatsapp.handleDisconnect(411, null);

    expect(vi.getTimerCount()).toBe(0);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("update Baileys");
  });

  it("428 (connectionClosed) reconnects with backoff", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const whatsapp = await importWhatsAppResolved();

    await whatsapp.handleDisconnect(428, null);

    expect(vi.getTimerCount()).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("Reconnecting in 2s");
  });

  it("440 (connectionReplaced) reconnects with extended delay", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const whatsapp = await importWhatsAppResolved();

    await whatsapp.handleDisconnect(440, null);

    expect(vi.getTimerCount()).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("Reconnecting in 10s");
  });

  it("500 (badSession) clears auth and reconnects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readdirSpy = vi.spyOn(fs.promises, "readdir").mockResolvedValue(["creds.json"] as any);
    const rmSpy = vi.spyOn(fs.promises, "rm").mockResolvedValue(undefined);
    const whatsapp = await importWhatsAppResolved();

    await whatsapp.handleDisconnect(500, null);

    expect(vi.getTimerCount()).toBe(1);
    expect(readdirSpy).toHaveBeenCalled();
    expect(rmSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("Bad session");
  });

  it("503 (unavailableService) reconnects with backoff", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const whatsapp = await importWhatsAppResolved();

    await whatsapp.handleDisconnect(503, null);

    expect(vi.getTimerCount()).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("Reconnecting in 2s");
  });

  it("515 (restartRequired) reconnects immediately", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const whatsapp = await importWhatsAppResolved();

    await whatsapp.handleDisconnect(515, null);

    expect(vi.getTimerCount()).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("Reconnecting in 0s");
  });

  it("unknown code reconnects with backoff and logs warning", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const whatsapp = await importWhatsAppResolved();

    await whatsapp.handleDisconnect(999, null);

    expect(vi.getTimerCount()).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("Unknown disconnect code");
  });

  it("stops reconnecting after MAX_RECONNECT_ATTEMPTS", async () => {
    process.env.MAX_RECONNECT_ATTEMPTS = "2";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const whatsapp = await importWhatsAppResolved();

    await whatsapp.handleDisconnect(428, null);
    await whatsapp.handleDisconnect(428, null);
    await whatsapp.handleDisconnect(428, null);

    expect(vi.getTimerCount()).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("Fatal");
  });

  it("successful connection resets reconnect attempt counter to zero", async () => {
    await setupTestDb();
    seedTestDb();

    const whatsapp = await import("../whatsapp.js");
    await whatsapp.initWhatsApp();

    latestSocket().emitConnectionClose(428);
    expect(whatsapp.getReconnectAttempts()).toBe(1);

    latestSocket().emitConnectionOpen();
    expect(whatsapp.getReconnectAttempts()).toBe(0);

    closeTestDb();
  });
});
