import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    socket.sendMessage = async (jid: string, content: Record<string, unknown>) => {
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

      socket.sentMessages.push({ jid, content });
      return { key: { id: `fake-msg-${socket.sentMessages.length}` } };
    };
    mockState.sockets.push(socket);
    return socket;
  }),
  DisconnectReason: {
    loggedOut: 401,
    connectionReplaced: 440,
  },
  fetchLatestBaileysVersion: vi.fn(async () => ({ version: [2, 3000, 0] })),
  downloadMediaMessage: vi.fn(async () => Buffer.from("fake-media-bytes")),
  getContentType: vi.fn((message: any) => Object.keys(message)[0]),
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

describe("integration: media flow", () => {
  const originalAllowedDir = process.env.ALLOWED_SEND_DIR;
  const originalDownloadsDir = process.env.DOWNLOADS_DIR;
  const originalWhisperApiKey = process.env.WHISPER_API_KEY;
  const originalWhisperApiUrl = process.env.WHISPER_API_URL;
  const originalWhisperModel = process.env.WHISPER_MODEL;

  let uploadDir: string;
  let downloadsDir: string;
  let server: McpServer;
  let client: Client;
  let closeWhatsApp: () => Promise<void>;

  beforeAll(async () => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "integration-upload-"));
    downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "integration-download-"));

    process.env.ALLOWED_SEND_DIR = uploadDir;
    process.env.DOWNLOADS_DIR = downloadsDir;
    process.env.MIN_SEND_INTERVAL_MS = "0";
    process.env.SEND_JITTER_MS = "0";
    process.env.WHISPER_API_KEY = "test-whisper-key";
    process.env.WHISPER_API_URL = "https://api.example.com/v1/audio/transcriptions";
    process.env.WHISPER_MODEL = "test-model";

    await setupTestDb();
    seedTestDb();

    const { getDb } = await import("../../db.js");
    const db = getDb();
    db.prepare(
      "INSERT INTO messages (id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media, message_blob, transcription) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "img-msg-1",
      "15550001111@s.whatsapp.net",
      0,
      "15550001111@s.whatsapp.net",
      "Alice Test",
      "image",
      null,
      1700000100,
      1,
      JSON.stringify({ message: { imageMessage: { mimetype: "image/png" } } }),
      null
    );
    db.prepare(
      "INSERT INTO messages (id, chat_jid, from_me, sender_jid, sender_name, type, text, timestamp, has_media, message_blob, transcription) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "voice-msg-1",
      "15550001111@s.whatsapp.net",
      0,
      "15550001111@s.whatsapp.net",
      "Alice Test",
      "voice_note",
      null,
      1700000110,
      1,
      JSON.stringify({ message: { audioMessage: { mimetype: "audio/ogg; codecs=opus" } } }),
      null
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          text: "Transcribed hello world",
          language: "en",
          duration: 1.23,
        }),
      }))
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
    vi.unstubAllGlobals();

    fs.rmSync(uploadDir, { recursive: true, force: true });
    fs.rmSync(downloadsDir, { recursive: true, force: true });

    if (originalAllowedDir === undefined) delete process.env.ALLOWED_SEND_DIR;
    else process.env.ALLOWED_SEND_DIR = originalAllowedDir;
    if (originalDownloadsDir === undefined) delete process.env.DOWNLOADS_DIR;
    else process.env.DOWNLOADS_DIR = originalDownloadsDir;
    if (originalWhisperApiKey === undefined) delete process.env.WHISPER_API_KEY;
    else process.env.WHISPER_API_KEY = originalWhisperApiKey;
    if (originalWhisperApiUrl === undefined) delete process.env.WHISPER_API_URL;
    else process.env.WHISPER_API_URL = originalWhisperApiUrl;
    if (originalWhisperModel === undefined) delete process.env.WHISPER_MODEL;
    else process.env.WHISPER_MODEL = originalWhisperModel;
  });

  it("handles send_file preview + send flow", async () => {
    const filePath = path.join(uploadDir, "story.txt");
    fs.writeFileSync(filePath, "integration media test");

    const preview = (await client.callTool({
      name: "send_file",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        filePath,
        caption: "preview cap",
        confirmed: false,
      },
    })) as RawToolResult;
    expect(preview.isError).toBeFalsy();
    expect(parseToolJson(preview)).toMatchObject({
      preview: true,
      fileName: "story.txt",
      recipient: expect.objectContaining({ jid: "15550001111@s.whatsapp.net" }),
    });

    const sent = (await client.callTool({
      name: "send_file",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        filePath,
        caption: "send cap",
        confirmed: true,
      },
    })) as RawToolResult;
    expect(sent.isError).toBeFalsy();
    expect(parseToolJson(sent)).toMatchObject({
      success: true,
      to: "15550001111@s.whatsapp.net",
      fileType: "document",
    });
  });

  it("downloads media and transcribes voice note", async () => {
    const download = (await client.callTool({
      name: "download_media",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        messageId: "img-msg-1",
      },
    })) as RawToolResult;

    const downloadPayload = parseToolJson(download) as any;
    expect(download.isError).toBeFalsy();
    expect(downloadPayload).toMatchObject({
      success: true,
      fileName: "img-msg-1.png",
      mimeType: "image/png",
      type: "imageMessage",
      size: "fake-media-bytes".length,
    });
    expect(fs.existsSync(downloadPayload.filePath)).toBe(true);

    const transcribed = (await client.callTool({
      name: "transcribe_voice_note",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        messageId: "voice-msg-1",
      },
    })) as RawToolResult;

    const transcribedPayload = parseToolJson(transcribed) as any;
    expect(transcribed.isError).toBeFalsy();
    expect(transcribedPayload).toMatchObject({
      success: true,
      messageId: "voice-msg-1",
      chatJid: "15550001111@s.whatsapp.net",
      transcription: "Transcribed hello world",
      language: "en",
      cached: false,
    });

    const cached = (await client.callTool({
      name: "transcribe_voice_note",
      arguments: {
        jid: "15550001111@s.whatsapp.net",
        messageId: "voice-msg-1",
      },
    })) as RawToolResult;
    expect(cached.isError).toBeFalsy();
    expect(parseToolJson(cached)).toMatchObject({
      success: true,
      messageId: "voice-msg-1",
      cached: true,
    });
  });
});
