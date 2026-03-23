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

function parseToolJson(result: RawToolResult): unknown {
  const text = result.content?.find((entry) => entry.type === "text")?.text || "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe("integration failures: edge cases", () => {
  let server: McpServer;
  let client: Client;
  let closeWhatsApp: () => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    mockState.sockets.length = 0;
    process.env.MIN_SEND_INTERVAL_MS = "0";
    process.env.SEND_JITTER_MS = "0";

    await setupTestDb();
    seedTestDb();

    const whatsapp = await import("../../whatsapp.js");
    closeWhatsApp = whatsapp.closeWhatsApp;
    await whatsapp.initWhatsApp();

    const socket = mockState.sockets.at(-1);
    if (!socket) throw new Error("Expected fake socket");
    socket.emitConnectionOpen();

    server = new McpServer({ name: "whatsapp-test", version: "1.0.0" });
    const { registerTools } = await import("../../tools.js");
    registerTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "whatsapp-test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await Promise.all([client?.close(), server?.close()]);
    await closeWhatsApp?.();
    closeTestDb();
  });

  it("empty search query is rejected or returns no broad match results", async () => {
    const result = (await client.callTool({
      name: "search_messages",
      arguments: {
        query: "",
      },
    })) as RawToolResult;

    const payload = parseToolJson(result);
    const isSafeError = result.isError === true;
    const isSafeNoResult =
      (typeof payload === "string" && payload.includes("No messages found")) ||
      (Array.isArray(payload) && payload.length === 0);

    expect(isSafeError || isSafeNoResult).toBe(true);
  });

  it("invalid JID format returns a clear validation error", async () => {
    const result = (await client.callTool({
      name: "send_message",
      arguments: {
        jid: "not-a-jid",
        text: "hello",
        confirmed: true,
      },
    })) as RawToolResult;

    const payload = parseToolJson(result) as string;
    expect(result.isError).toBe(true);
    expect(payload).toContain("Invalid phone number or JID");
  });

  it("download_media returns clear error when message has no media", async () => {
    const result = (await client.callTool({
      name: "download_media",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        messageId: "seed-msg-1",
      },
    })) as RawToolResult;

    const payload = parseToolJson(result) as string;
    expect(result.isError).toBe(true);
    expect(payload).toContain("has no downloadable media");
  });
});
