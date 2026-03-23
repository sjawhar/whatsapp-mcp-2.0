import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createFakeBaileysSocket, type FakeBaileysSocket } from "../helpers/fake-baileys.js";
import { closeTestDb, seedTestDb, setupTestDb } from "../helpers/test-db.js";

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

type RawToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

function latestSocket(): FakeBaileysSocket {
  const socket = mockState.sockets.at(-1);
  if (!socket) throw new Error("No fake socket was created");
  return socket;
}

function totalListeners(socket: FakeBaileysSocket): number {
  return socket.ev.eventNames().reduce((count, event) => count + socket.ev.listenerCount(event), 0);
}

describe("integration failures: resource management", () => {
  const originalMinInterval = process.env.MIN_SEND_INTERVAL_MS;
  const originalJitter = process.env.SEND_JITTER_MS;

  let server: McpServer;
  let client: Client;
  let whatsapp: typeof import("../../whatsapp.js");

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    mockState.sockets.length = 0;

    process.env.MIN_SEND_INTERVAL_MS = "3000";
    process.env.SEND_JITTER_MS = "0";

    await setupTestDb();
    seedTestDb();

    whatsapp = await import("../../whatsapp.js");
    await whatsapp.initWhatsApp();
    latestSocket().emitConnectionOpen();

    server = new McpServer({ name: "whatsapp-test", version: "1.0.0" });
    const { registerTools } = await import("../../tools.js");
    registerTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "whatsapp-test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await Promise.all([client?.close(), server?.close()]);
    await whatsapp?.closeWhatsApp();
    closeTestDb();
    vi.useRealTimers();

    if (originalMinInterval === undefined) delete process.env.MIN_SEND_INTERVAL_MS;
    else process.env.MIN_SEND_INTERVAL_MS = originalMinInterval;
    if (originalJitter === undefined) delete process.env.SEND_JITTER_MS;
    else process.env.SEND_JITTER_MS = originalJitter;
  });

  it("enforces minimum interval between rapid send_message calls", async () => {
    const first = client.callTool({
      name: "send_message",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        text: "first",
        confirmed: true,
      },
    }) as Promise<RawToolResult>;
    await vi.advanceTimersByTimeAsync(0);
    await first;

    const second = client.callTool({
      name: "send_message",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        text: "second",
        confirmed: true,
      },
    }) as Promise<RawToolResult>;

    let settled = false;
    second.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await second;
    expect(settled).toBe(true);
    expect(result.isError).toBeFalsy();
  });

  it("keeps listener count stable across reconnect cycles", async () => {
    const firstSocket = latestSocket();
    const baselineCount = totalListeners(firstSocket);
    expect(baselineCount).toBeGreaterThan(0);

    const historicalSockets: FakeBaileysSocket[] = [firstSocket];

    for (let i = 0; i < 3; i++) {
      await whatsapp.initWhatsApp();
      const newest = latestSocket();
      historicalSockets.push(newest);
      expect(totalListeners(newest)).toBe(baselineCount);
    }

    for (const staleSocket of historicalSockets.slice(0, -1)) {
      expect(totalListeners(staleSocket)).toBe(0);
    }
  });
});
