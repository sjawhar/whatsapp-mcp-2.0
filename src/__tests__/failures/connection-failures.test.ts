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

function extractText(result: RawToolResult): string {
  return result.content?.find((entry) => entry.type === "text")?.text || "";
}

describe("integration failures: connection handling", () => {
  const originalMaxReconnectAttempts = process.env.MAX_RECONNECT_ATTEMPTS;
  const originalZombieTimeout = process.env.ZOMBIE_TIMEOUT_MS;

  let server: McpServer;
  let client: Client;
  let whatsapp: typeof import("../../whatsapp.js");

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    mockState.sockets.length = 0;
    process.env.MIN_SEND_INTERVAL_MS = "0";
    process.env.SEND_JITTER_MS = "0";
    process.env.MAX_RECONNECT_ATTEMPTS = "2";
    process.env.ZOMBIE_TIMEOUT_MS = "2000";

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

    if (originalMaxReconnectAttempts === undefined) delete process.env.MAX_RECONNECT_ATTEMPTS;
    else process.env.MAX_RECONNECT_ATTEMPTS = originalMaxReconnectAttempts;
    if (originalZombieTimeout === undefined) delete process.env.ZOMBIE_TIMEOUT_MS;
    else process.env.ZOMBIE_TIMEOUT_MS = originalZombieTimeout;
  });

  it("returns a tool error (not hang) when disconnect occurs mid send_message call", async () => {
    vi.useRealTimers();

    const socket = latestSocket();
    vi.spyOn(socket, "sendMessage").mockImplementation(async () => {
      socket.emitConnectionClose(440);
      throw new Error("socket disconnected during send");
    });

    const toolCall = client.callTool({
      name: "send_message",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        text: "should-fail",
        confirmed: true,
      },
    }) as Promise<RawToolResult>;

    const settleState = await Promise.race([
      toolCall.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    expect(settleState).toBe("settled");
    const result = await toolCall;
    expect(result.isError).toBe(true);
    expect(extractText(result)).toContain("socket disconnected during send");

    vi.useFakeTimers();
  });

  it("increases reconnect backoff across repeated disconnect events", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    latestSocket().emitConnectionClose(428);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("Reconnecting in 2s");

    latestSocket().emitConnectionClose(428);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("Reconnecting in 4s");
  });

  it("stops reconnect scheduling after MAX_RECONNECT_ATTEMPTS cap", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    latestSocket().emitConnectionClose(428);
    latestSocket().emitConnectionClose(428);
    latestSocket().emitConnectionClose(428);

    const logText = errorSpy.mock.calls.flat().join(" ");
    expect(logText).toContain("MAX_RECONNECT_ATTEMPTS (2)");
    expect(logText).toContain("Stopping reconnect attempts");
  });

  it("detects zombie socket after silence timeout", async () => {
    const socket = latestSocket();
    socket.emitConnectionOpen();
    const endSpy = vi.spyOn(socket, "end");

    await vi.advanceTimersByTimeAsync(2_500);

    expect(endSpy).toHaveBeenCalled();
    const firstErrorArg = (endSpy.mock.calls as unknown[][]).at(0)?.[0];
    expect(firstErrorArg).toBeInstanceOf(Error);
    if (firstErrorArg instanceof Error) {
      expect(firstErrorArg.message).toContain("Zombie connection detected");
    }
  });
});
