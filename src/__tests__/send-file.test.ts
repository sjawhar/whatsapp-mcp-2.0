import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeTestDb, seedTestDb, setupTestDb } from "./helpers/test-db.js";

vi.mock("@whiskeysockets/baileys", () => {
  const listeners = new Map<string, Array<(payload: any) => void | Promise<void>>>();

  const ev = {
    on(event: string, handler: (payload: any) => void | Promise<void>) {
      const arr = listeners.get(event) || [];
      arr.push(handler);
      listeners.set(event, arr);
    },
    process(handler: (events: Record<string, unknown>) => void | Promise<void>) {
      const arr = listeners.get("event") || [];
      arr.push(handler);
      listeners.set("event", arr);
    },
    emit(event: string, payload: any) {
      for (const handler of listeners.get(event) || []) {
        void handler(payload);
      }
    },
    emitBatch(payload: Record<string, unknown>) {
      for (const handler of listeners.get("event") || []) {
        void handler(payload);
      }
    },
    removeAllListeners() {
      listeners.clear();
    },
  };

  const fakeSocket = {
    ev,
    sentMessages: [] as Array<{ jid: string; content: Record<string, unknown> }>,
    user: {
      id: "15559990000@s.whatsapp.net",
      name: "Test User",
      lid: "15559990000@lid",
    },
    async sendMessage(jid: string, content: Record<string, unknown>) {
      const streamLike = [content.image, content.video, content.audio, content.document].find(
        (value) => value && typeof (value as any).on === "function"
      ) as any;

      if (streamLike) {
        await new Promise<void>((resolve) => {
          streamLike.on("open", () => {
            streamLike.destroy();
            resolve();
          });
          streamLike.on("error", () => resolve());
        });
      }

      fakeSocket.sentMessages.push({ jid, content });
      return { key: { id: `fake-msg-${fakeSocket.sentMessages.length}` } };
    },
    async chatModify() {
      return undefined;
    },
    async groupMetadata(jid: string) {
      return { subject: `Group ${jid}` };
    },
    async updateMediaMessage() {
      return undefined;
    },
    end() {
      listeners.clear();
    },
  };

  return {
    default: vi.fn(() => fakeSocket),
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
    __fakeSocket: fakeSocket,
  };
});

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

describe("send_file security", () => {
  const originalAllowedDir = process.env.ALLOWED_SEND_DIR;
  const originalMaxSize = process.env.MAX_SEND_FILE_SIZE;

  let tempDir: string;
  let server: McpServer;
  let client: Client;
  let closeWhatsApp: () => Promise<void>;

  beforeAll(async () => {
    await setupTestDb();
    seedTestDb();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "send-file-test-"));
    process.env.ALLOWED_SEND_DIR = tempDir;
    process.env.MAX_SEND_FILE_SIZE = "67108864";

    const whatsapp = await import("../whatsapp.js");
    closeWhatsApp = whatsapp.closeWhatsApp;
    await whatsapp.initWhatsApp();

    const baileys = await import("@whiskeysockets/baileys");
    (baileys as any).__fakeSocket.ev.emitBatch({
      "connection.update": { connection: "open" },
    });

    server = new McpServer({ name: "whatsapp-test", version: "1.0.0" });
    const { registerTools } = await import("../tools.js");
    registerTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "whatsapp-test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await Promise.all([client?.close(), server?.close()]);
    await closeWhatsApp?.();
    closeTestDb();
    fs.rmSync(tempDir, { recursive: true, force: true });

    if (originalAllowedDir === undefined) {
      delete process.env.ALLOWED_SEND_DIR;
    } else {
      process.env.ALLOWED_SEND_DIR = originalAllowedDir;
    }

    if (originalMaxSize === undefined) {
      delete process.env.MAX_SEND_FILE_SIZE;
    } else {
      process.env.MAX_SEND_FILE_SIZE = originalMaxSize;
    }
  });

  it("returns preview when confirmed=false and does not send", async () => {
    const filePath = path.join(tempDir, "preview.txt");
    fs.writeFileSync(filePath, "hello");

    const before = (await import("@whiskeysockets/baileys") as any).__fakeSocket.sentMessages.length;
    const result = (await client.callTool({
      name: "send_file",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        filePath,
        caption: "preview",
        confirmed: false,
      },
    })) as RawToolResult;

    const payload = parseToolJson(result) as any;
    const after = (await import("@whiskeysockets/baileys") as any).__fakeSocket.sentMessages.length;

    expect(result.isError).toBeFalsy();
    expect(payload).toMatchObject({
      preview: true,
      fileName: "preview.txt",
      fileSize: 5,
      recipient: expect.objectContaining({
        jid: "15550001111@s.whatsapp.net",
      }),
    });
    expect(after).toBe(before);
  });

  it("rejects traversal path with Path not allowed", async () => {
    const result = (await client.callTool({
      name: "send_file",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        filePath: "../../etc/passwd",
        confirmed: true,
      },
    })) as RawToolResult;

    const text = (parseToolJson(result) as string) || "";
    expect(result.isError).toBe(true);
    expect(text).toContain("Path not allowed");
  });

  it("rejects absolute path outside allowlist", async () => {
    const result = (await client.callTool({
      name: "send_file",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        filePath: "/home/user/.ssh/id_rsa",
        confirmed: true,
      },
    })) as RawToolResult;

    const text = (parseToolJson(result) as string) || "";
    expect(result.isError).toBe(true);
    expect(text).toContain("Path not allowed");
  });

  it("rejects file larger than MAX_SEND_FILE_SIZE", async () => {
    process.env.MAX_SEND_FILE_SIZE = "4";
    const filePath = path.join(tempDir, "too-large.txt");
    fs.writeFileSync(filePath, "12345");

    const result = (await client.callTool({
      name: "send_file",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        filePath,
        confirmed: true,
      },
    })) as RawToolResult;

    const text = (parseToolJson(result) as string) || "";
    expect(result.isError).toBe(true);
    expect(text).toContain("File too large");

    process.env.MAX_SEND_FILE_SIZE = "67108864";
  });

  it("sends successfully when confirmed=true with allowed path under size limit", async () => {
    const filePath = path.join(tempDir, "ok.txt");
    fs.writeFileSync(filePath, "ok");

    const result = (await client.callTool({
      name: "send_file",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        filePath,
        caption: "ok",
        confirmed: true,
      },
    })) as RawToolResult;

    const payload = parseToolJson(result) as any;

    expect(result.isError).toBeFalsy();
    expect(payload).toMatchObject({
      success: true,
      to: "15550001111@s.whatsapp.net",
    });
  });
});
