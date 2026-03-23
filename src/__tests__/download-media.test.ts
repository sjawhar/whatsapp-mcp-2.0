import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const getMessageBlobMock = vi.fn(() => JSON.stringify({ message: { imageMessage: { mimetype: "image/png" } } }));

vi.mock("@whiskeysockets/baileys", () => ({
  default: vi.fn(() => ({})),
  DisconnectReason: { loggedOut: 401, connectionReplaced: 440 },
  fetchLatestBaileysVersion: vi.fn(async () => ({ version: [2, 3000, 0] })),
  downloadMediaMessage: vi.fn(async () => Buffer.from("fake-image")),
  getContentType: vi.fn(() => "imageMessage"),
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

vi.mock("../db.js", () => ({
  getMessageBlob: getMessageBlobMock,
  getChatName: vi.fn(() => null),
  getContactName: vi.fn(() => null),
  upsertContact: vi.fn(),
  upsertChat: vi.fn(),
  saveJidMapping: vi.fn(),
  upsertChats: vi.fn(),
  upsertContacts: vi.fn(),
  upsertMessages: vi.fn(),
  upsertMessage: vi.fn(),
  deleteChat: vi.fn(),
  deleteChatMessages: vi.fn(),
  getChats: vi.fn(() => []),
  getChat: vi.fn(() => ({})),
  getMessages: vi.fn(() => []),
  searchMessages: vi.fn(() => []),
  searchContacts: vi.fn(() => []),
  getMessageContext: vi.fn(() => ({})),
  getLastMessageKey: vi.fn(() => null),
  getMessageFromMe: vi.fn(() => null),
  deleteMessage: vi.fn(),
  getMessageTypeById: vi.fn(() => "voice_note"),
  getTranscription: vi.fn(() => null),
  saveTranscription: vi.fn(),
}));

const originalDownloadsDir = process.env.DOWNLOADS_DIR;

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock("../utils.js");

  if (originalDownloadsDir === undefined) {
    delete process.env.DOWNLOADS_DIR;
  } else {
    process.env.DOWNLOADS_DIR = originalDownloadsDir;
  }
});

describe("download_media security hardening", () => {
  it("sanitizes traversal messageId so writes stay inside downloads dir", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-media-"));
    process.env.DOWNLOADS_DIR = tempDir;

    const whatsapp = await import("../whatsapp.js");
    whatsapp.resolveConnectionAsReadOnly();

    const result = await whatsapp.downloadMessageMedia("15550001111", "../../../tmp/evil");

    expect(result.fileName).toBe(".._.._.._tmp_evil.png");
    expect(path.resolve(String(result.filePath)).startsWith(path.resolve(tempDir) + path.sep)).toBe(true);
    expect(fs.existsSync(String(result.filePath))).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("sanitizes backslashes in messageId", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-media-"));
    process.env.DOWNLOADS_DIR = tempDir;

    const whatsapp = await import("../whatsapp.js");
    whatsapp.resolveConnectionAsReadOnly();

    const result = await whatsapp.downloadMessageMedia("15550001111", "..\\..\\evil");

    expect(result.fileName).toBe(".._.._evil.png");
    expect(path.resolve(String(result.filePath)).startsWith(path.resolve(tempDir) + path.sep)).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects resolved output path outside downloads directory", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-media-"));
    process.env.DOWNLOADS_DIR = tempDir;

    vi.doMock("../utils.js", async () => {
      const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
      return {
        ...actual,
        sanitizeFilename: (name: string) => name,
      };
    });

    const whatsapp = await import("../whatsapp.js");
    whatsapp.resolveConnectionAsReadOnly();

    await expect(
      whatsapp.downloadMessageMedia("15550001111", "../../../tmp/evil")
    ).rejects.toThrow("Path traversal detected");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps normal message IDs unchanged", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-media-"));
    process.env.DOWNLOADS_DIR = tempDir;

    const whatsapp = await import("../whatsapp.js");
    whatsapp.resolveConnectionAsReadOnly();

    const result = await whatsapp.downloadMessageMedia("15550001111", "abc-123-def");
    expect(result.fileName).toBe("abc-123-def.png");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("exports strict sanitizeFilename allowlist behavior", async () => {
    const { sanitizeFilename } = await import("../utils.js");

    expect(sanitizeFilename("../../../tmp/evil")).toBe(".._.._.._tmp_evil");
    expect(sanitizeFilename("..\\..\\evil")).toBe(".._.._evil");
    expect(sanitizeFilename("abc-123_DEF.9")).toBe("abc-123_DEF.9");
  });
});
