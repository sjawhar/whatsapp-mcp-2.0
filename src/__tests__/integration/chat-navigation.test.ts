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

describe("integration: chat navigation + deletion flow", () => {
  let server: McpServer;
  let client: Client;
  let closeWhatsApp: () => Promise<void>;

  beforeAll(async () => {
    process.env.MIN_SEND_INTERVAL_MS = "0";
    process.env.SEND_JITTER_MS = "0";

    await setupTestDb();
    seedTestDb();

    const { getDb } = await import("../../db.js");
    const db = getDb();
    db.prepare(
      "INSERT INTO messages (id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media, message_blob, transcription) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "seed-msg-2",
      "15550001111@s.whatsapp.net",
      1,
      "15559990000@s.whatsapp.net",
      "Me",
      "text",
      "Second seeded message",
      1700000001,
      0,
      null,
      null
    );
    db.prepare(
      "INSERT INTO messages (id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media, message_blob, transcription) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "seed-msg-3",
      "15550001111@s.whatsapp.net",
      0,
      "15550001111@s.whatsapp.net",
      "Alice Test",
      "text",
      "Third seeded message",
      1700000002,
      0,
      null,
      null
    );

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
  });

  it("navigates chat data and performs delete previews + confirmed deletions", async () => {
    const chats = (await client.callTool({
      name: "list_chats",
      arguments: { limit: 10 },
    })) as RawToolResult;
    expect(chats.isError).toBeFalsy();
    expect(parseToolJson(chats)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jid: "15550001111@s.whatsapp.net", name: "Alice Test" }),
      ])
    );

    const chat = (await client.callTool({
      name: "get_chat",
      arguments: { jid: "15550001111" },
    })) as RawToolResult;
    expect(chat.isError).toBeFalsy();
    expect(parseToolJson(chat)).toMatchObject({
      jid: "15550001111@s.whatsapp.net",
      name: "Alice Test",
      recentMessages: expect.any(Array),
    });

    const messages = (await client.callTool({
      name: "list_messages",
      arguments: { jid: "15550001111", limit: 3 },
    })) as RawToolResult;
    const messagePayload = parseToolJson(messages) as any[];
    expect(messages.isError).toBeFalsy();
    expect(messagePayload).toHaveLength(3);
    expect(messagePayload[0]).toMatchObject({ id: "seed-msg-3" });

    const context = (await client.callTool({
      name: "get_message_context",
      arguments: {
        jid: "15550001111",
        messageId: "seed-msg-2",
        count: 1,
      },
    })) as RawToolResult;
    expect(context.isError).toBeFalsy();
    expect(parseToolJson(context)).toMatchObject({
      messages: expect.any(Array),
      targetIndex: expect.any(Number),
    });

    const deleteMessagePreview = (await client.callTool({
      name: "delete_message",
      arguments: {
        jid: "15550001111",
        messageId: "seed-msg-2",
        confirmed: false,
      },
    })) as RawToolResult;
    expect(deleteMessagePreview.isError).toBeFalsy();
    expect(parseToolJson(deleteMessagePreview)).toMatchObject({
      status: "confirmation_required",
      jid: "15550001111@s.whatsapp.net",
      messageId: "seed-msg-2",
    });

    const deleteMessageConfirmed = (await client.callTool({
      name: "delete_message",
      arguments: {
        jid: "15550001111",
        messageId: "seed-msg-2",
        confirmed: true,
      },
    })) as RawToolResult;
    expect(deleteMessageConfirmed.isError).toBeFalsy();
    expect(parseToolJson(deleteMessageConfirmed)).toMatchObject({
      success: true,
      jid: "15550001111@s.whatsapp.net",
      messageId: "seed-msg-2",
    });

    const deleteChatPreview = (await client.callTool({
      name: "delete_chat",
      arguments: {
        jid: "15550001111",
        confirmed: false,
      },
    })) as RawToolResult;
    expect(deleteChatPreview.isError).toBeFalsy();
    expect(parseToolJson(deleteChatPreview)).toMatchObject({
      status: "confirmation_required",
      jid: "15550001111@s.whatsapp.net",
    });

    const deleteChatConfirmed = (await client.callTool({
      name: "delete_chat",
      arguments: {
        jid: "15550001111",
        confirmed: true,
      },
    })) as RawToolResult;
    expect(deleteChatConfirmed.isError).toBeFalsy();
    expect(parseToolJson(deleteChatConfirmed)).toMatchObject({
      success: true,
      jid: "15550001111@s.whatsapp.net",
    });
  });
});
