import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
    connectionReplaced: 440,
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

describe("integration: send_message", () => {
  const originalMinInterval = process.env.MIN_SEND_INTERVAL_MS;
  const originalJitter = process.env.SEND_JITTER_MS;

  let server: McpServer;
  let client: Client;
  let closeWhatsApp: () => Promise<void>;

  beforeAll(async () => {
    process.env.MIN_SEND_INTERVAL_MS = "150";
    process.env.SEND_JITTER_MS = "0";

    await setupTestDb();
    seedTestDb();

    const whatsapp = await import("../../whatsapp.js");
    closeWhatsApp = whatsapp.closeWhatsApp;
    await whatsapp.initWhatsApp();

    const socket = mockState.sockets.at(-1);
    if (!socket) throw new Error("Expected fake Baileys socket");
    socket.emitConnectionOpen();

    server = new McpServer({ name: "whatsapp-test", version: "1.0.0" });
    const { registerTools } = await import("../../tools.js");
    registerTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "whatsapp-test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await Promise.all([client?.close(), server?.close()]);
    await closeWhatsApp?.();
    closeTestDb();

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

  it("returns preview when confirmed=false", async () => {
    const socket = mockState.sockets.at(-1);
    if (!socket) throw new Error("Expected fake Baileys socket");

    const before = socket.sentMessages.length;
    const result = (await client.callTool({
      name: "send_message",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        text: "Preview only",
        confirmed: false,
      },
    })) as RawToolResult;

    const payload = parseToolJson(result) as any;

    expect(result.isError).toBeFalsy();
    expect(payload).toMatchObject({
      status: "confirmation_required",
      jid: "15550001111@s.whatsapp.net",
      phone: "15550001111",
      message: "Preview only",
    });
    expect(socket.sentMessages.length).toBe(before);
  });

  it("sends when confirmed=true", async () => {
    const socket = mockState.sockets.at(-1);
    if (!socket) throw new Error("Expected fake Baileys socket");

    const result = (await client.callTool({
      name: "send_message",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        text: "Actually send this",
        confirmed: true,
      },
    })) as RawToolResult;

    const payload = parseToolJson(result) as any;

    expect(result.isError).toBeFalsy();
    expect(payload).toMatchObject({
      success: true,
      to: "15550001111@s.whatsapp.net",
      messageId: expect.any(String),
    });
    expect(socket.sentMessages.at(-1)).toMatchObject({
      jid: "15550001111@s.whatsapp.net",
      content: { text: "Actually send this" },
    });
  });

  it("applies rate limiting delay for second rapid send", async () => {
    const firstResult = (await client.callTool({
      name: "send_message",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        text: "first rapid",
        confirmed: true,
      },
    })) as RawToolResult;
    expect(firstResult.isError).toBeFalsy();

    const started = Date.now();
    const secondResult = (await client.callTool({
      name: "send_message",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        text: "second rapid",
        confirmed: true,
      },
    })) as RawToolResult;
    const elapsed = Date.now() - started;

    const payload = parseToolJson(secondResult) as any;
    expect(secondResult.isError).toBeFalsy();
    expect(payload.success).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(120);
  });
});
