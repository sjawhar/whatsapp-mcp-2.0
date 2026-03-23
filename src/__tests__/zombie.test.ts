import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    connectionClosed: 428,
    connectionReplaced: 440,
    badSession: 500,
    unavailableService: 503,
    restartRequired: 515,
    connectionLost: 408,
    forbidden: 403,
    multideviceMismatch: 411,
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
  if (!socket) throw new Error("No fake socket was created");
  return socket;
}

describe("zombie watchdog + send health check", () => {
  const originalZombieTimeout = process.env.ZOMBIE_TIMEOUT_MS;
  const originalMaxSendFailures = process.env.MAX_SEND_FAILURES;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    mockState.sockets.length = 0;
    process.env.ZOMBIE_TIMEOUT_MS = "120000";
    process.env.MAX_SEND_FAILURES = "3";

    await setupTestDb();
    seedTestDb();
  });

  afterEach(async () => {
    const whatsapp = await import("../whatsapp.js");
    await whatsapp.closeWhatsApp();
    closeTestDb();
    vi.useRealTimers();

    if (originalZombieTimeout === undefined) {
      delete process.env.ZOMBIE_TIMEOUT_MS;
    } else {
      process.env.ZOMBIE_TIMEOUT_MS = originalZombieTimeout;
    }

    if (originalMaxSendFailures === undefined) {
      delete process.env.MAX_SEND_FAILURES;
    } else {
      process.env.MAX_SEND_FAILURES = originalMaxSendFailures;
    }
  });

  it("forces socket end after 2 minutes without connection.update activity", async () => {
    const whatsapp = await import("../whatsapp.js");
    await whatsapp.initWhatsApp();
    const socket = latestSocket();
    socket.emitConnectionOpen();

    const endSpy = vi.spyOn(socket, "end");

    vi.advanceTimersByTime(121_000);

    expect(endSpy).toHaveBeenCalled();
    const firstEndArg = (endSpy.mock.calls as unknown[][]).at(0)?.[0];
    expect(firstEndArg).toBeInstanceOf(Error);
    if (firstEndArg instanceof Error) {
      expect(firstEndArg.message).toContain("Zombie connection detected");
    }
  });

  it("clears zombie watchdog timer when socket disconnects", async () => {
    const whatsapp = await import("../whatsapp.js");
    await whatsapp.initWhatsApp();
    const socket = latestSocket();
    socket.emitConnectionOpen();

    expect(vi.getTimerCount()).toBe(1);

    socket.emitConnectionClose(428);

    expect(vi.getTimerCount()).toBe(1);
  });

  it("forces reconnect after 3 consecutive send failures", async () => {
    const whatsapp = await import("../whatsapp.js");
    await whatsapp.initWhatsApp();
    const socket = latestSocket();
    socket.emitConnectionOpen();

    const endSpy = vi.spyOn(socket, "end");
    const sendSpy = vi.spyOn(socket, "sendMessage").mockRejectedValue(new Error("send failed"));

    await expect(whatsapp.sendTextMessage("15550001111", "one")).rejects.toThrow("send failed");
    await expect(whatsapp.sendTextMessage("15550001111", "two")).rejects.toThrow("send failed");
    await expect(whatsapp.sendTextMessage("15550001111", "three")).rejects.toThrow("send failed");

    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(endSpy).toHaveBeenCalled();
    const firstEndArg = (endSpy.mock.calls as unknown[][]).at(0)?.[0];
    expect(firstEndArg).toBeInstanceOf(Error);
    if (firstEndArg instanceof Error) {
      expect(firstEndArg.message).toContain("Send health check failed");
    }
  });

  it("resets consecutive send failures to zero after a successful send", async () => {
    const whatsapp = await import("../whatsapp.js");
    await whatsapp.initWhatsApp();
    const socket = latestSocket();
    socket.emitConnectionOpen();

    const endSpy = vi.spyOn(socket, "end");
    const sendSpy = vi.spyOn(socket, "sendMessage");
    sendSpy
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockResolvedValueOnce({ key: { id: "ok" } })
      .mockRejectedValueOnce(new Error("fail-3"))
      .mockRejectedValueOnce(new Error("fail-4"))
      .mockRejectedValueOnce(new Error("fail-5"));

    await expect(whatsapp.sendTextMessage("15550001111", "a")).rejects.toThrow("fail-1");
    await expect(whatsapp.sendTextMessage("15550001111", "b")).rejects.toThrow("fail-2");
    await expect(whatsapp.sendTextMessage("15550001111", "c")).resolves.toMatchObject({ success: true });
    await expect(whatsapp.sendTextMessage("15550001111", "d")).rejects.toThrow("fail-3");
    await expect(whatsapp.sendTextMessage("15550001111", "e")).rejects.toThrow("fail-4");

    expect(endSpy).not.toHaveBeenCalled();

    await expect(whatsapp.sendTextMessage("15550001111", "f")).rejects.toThrow("fail-5");
    expect(endSpy).toHaveBeenCalledTimes(1);
  });
});
