import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

type RawToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

function parseToolJson(result: RawToolResult): unknown {
  const text = result.content?.find((entry) => entry.type === "text")?.text || "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function latestSocket(): FakeBaileysSocket {
  const socket = mockState.sockets.at(-1);
  if (!socket) {
    throw new Error("No fake socket was created");
  }
  return socket;
}

describe("connection lifecycle", () => {
  let server: McpServer;
  let client: Client;
  let whatsapp: typeof import("../whatsapp.js");

  beforeEach(async () => {
    vi.resetModules();
    mockState.sockets.length = 0;

    await setupTestDb();
    seedTestDb();

    whatsapp = await import("../whatsapp.js");
    await whatsapp.initWhatsApp();
    latestSocket().emitConnectionOpen();

    server = new McpServer({ name: "whatsapp-test", version: "1.0.0" });
    const { registerTools } = await import("../tools.js");
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
  });

  it("waits for reconnection after a 440 connectionReplaced disconnect and succeeds after reconnect", async () => {
    latestSocket().emitConnectionClose(440);

    const toolCall = client.callTool({
      name: "list_chats",
      arguments: { limit: 5 },
    }) as Promise<RawToolResult>;

    const stateBeforeReconnect = await Promise.race([
      toolCall.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);

    expect(stateBeforeReconnect).toBe("pending");

    await whatsapp.initWhatsApp();
    latestSocket().emitConnectionOpen();

    const result = await toolCall;
    const payload = parseToolJson(result);

    expect(result.isError).toBeFalsy();
    expect(Array.isArray(payload)).toBe(true);

    const postReconnect = (await client.callTool({
      name: "list_chats",
      arguments: { limit: 5 },
    })) as RawToolResult;
    expect(postReconnect.isError).toBeFalsy();
  });

  it("clears pending reconnect timer on shutdown", async () => {
    vi.useFakeTimers();

    latestSocket().emitConnectionClose(500);

    expect(vi.getTimerCount()).toBe(1);

    await whatsapp.closeWhatsApp();

    expect(vi.getTimerCount()).toBe(0);
  });
});
