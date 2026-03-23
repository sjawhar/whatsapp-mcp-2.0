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

describe("SendRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays when called rapidly", async () => {
    const { SendRateLimiter } = await import("../whatsapp.js");
    const limiter = new SendRateLimiter(3000, 0); // no jitter for deterministic test

    // First call: no delay (lastSendTimestamp is 0)
    const start = Date.now();
    const p1 = limiter.throttle();
    await vi.advanceTimersByTimeAsync(0);
    await p1;
    const afterFirst = Date.now();

    // Second call immediately: should delay by ~3000ms
    const p2 = limiter.throttle();
    // Should NOT have resolved yet
    let resolved = false;
    p2.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await p2;
    expect(Date.now() - afterFirst).toBeGreaterThanOrEqual(3000);
  });

  it("does not delay when enough time has elapsed", async () => {
    const { SendRateLimiter } = await import("../whatsapp.js");
    const limiter = new SendRateLimiter(3000, 0);

    await limiter.throttle();

    // Advance well past the interval
    vi.advanceTimersByTime(5000);

    const before = Date.now();
    const p2 = limiter.throttle();
    // Should resolve almost immediately (no setTimeout needed)
    await vi.advanceTimersByTimeAsync(0);
    await p2;
    // Elapsed should be minimal (just jitter=0)
    expect(Date.now() - before).toBeLessThan(100);
  });

  it("adds random jitter to delay", async () => {
    const { SendRateLimiter } = await import("../whatsapp.js");

    // First call: no jitter. Second call: jitter = 0.5 * 2000 = 1000ms
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    const limiter = new SendRateLimiter(3000, 2000);

    await limiter.throttle();

    // Second call: should delay 3000ms (min interval) + 1000ms (jitter) = 4000ms
    const p2 = limiter.throttle();
    let resolved = false;
    p2.then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(3999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await p2;
    expect(resolved).toBe(true);

    vi.spyOn(Math, "random").mockRestore();
  });

  it("always adds jitter even when enough time elapsed", async () => {
    const { SendRateLimiter } = await import("../whatsapp.js");

    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    const limiter = new SendRateLimiter(3000, 2000);

    await limiter.throttle();
    vi.advanceTimersByTime(10000); // well past min interval

    // Jitter = 0.5 * 2000 = 1000ms delay even though min interval passed
    const p2 = limiter.throttle();
    let resolved = false;
    p2.then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await p2;
    expect(resolved).toBe(true);

    vi.spyOn(Math, "random").mockRestore();
  });
});

describe("rate limiting integration", () => {
  const originalMinInterval = process.env.MIN_SEND_INTERVAL_MS;
  const originalJitter = process.env.SEND_JITTER_MS;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    mockState.sockets.length = 0;
    process.env.MIN_SEND_INTERVAL_MS = "3000";
    process.env.SEND_JITTER_MS = "0"; // no jitter for predictable integration tests

    await setupTestDb();
    seedTestDb();
  });

  afterEach(async () => {
    const whatsapp = await import("../whatsapp.js");
    await whatsapp.closeWhatsApp();
    closeTestDb();
    vi.useRealTimers();

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

  it("delays second rapid send_message by at least MIN_SEND_INTERVAL_MS", async () => {
    const whatsapp = await import("../whatsapp.js");
    await whatsapp.initWhatsApp();
    const socket = latestSocket();
    socket.emitConnectionOpen();

    // First send — should go immediately
    const p1 = whatsapp.sendTextMessage("15550001111", "first");
    await vi.advanceTimersByTimeAsync(0);
    await p1;

    // Second send immediately — should be delayed
    const p2 = whatsapp.sendTextMessage("15550001111", "second");
    let secondDone = false;
    p2.then(() => { secondDone = true; });

    // At 2999ms, should NOT be done
    await vi.advanceTimersByTimeAsync(2999);
    expect(secondDone).toBe(false);

    // At 3000ms, should complete
    await vi.advanceTimersByTimeAsync(1);
    await p2;
    expect(secondDone).toBe(true);
  });

  it("respects env var configuration for MIN_SEND_INTERVAL_MS", async () => {
    // Already set MIN_SEND_INTERVAL_MS=3000 and SEND_JITTER_MS=0 in beforeEach
    // This test validates the module reads them
    const whatsapp = await import("../whatsapp.js");
    await whatsapp.initWhatsApp();
    const socket = latestSocket();
    socket.emitConnectionOpen();

    const p1 = whatsapp.sendTextMessage("15550001111", "a");
    await vi.advanceTimersByTimeAsync(0);
    await p1;

    const p2 = whatsapp.sendTextMessage("15550001111", "b");
    let done = false;
    p2.then(() => { done = true; });

    await vi.advanceTimersByTimeAsync(2500);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    await p2;
    expect(done).toBe(true);
  });
});
