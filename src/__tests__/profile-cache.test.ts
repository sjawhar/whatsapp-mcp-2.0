import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock db.js before importing whatsapp.ts
vi.mock("../db.js", () => ({
  getUserProfile: vi.fn(),
  getUnmappedLidJids: vi.fn(() => []),
  getPhoneJid: vi.fn(),
  getLidJid: vi.fn(),
  getContactName: vi.fn(),
  getDb: vi.fn(),
  upsertChat: vi.fn(),
  upsertContact: vi.fn(),
  upsertMessage: vi.fn(),
  upsertMessages: vi.fn(),
  upsertChats: vi.fn(),
  upsertContacts: vi.fn(),
  upsertUserProfile: vi.fn(),
  deleteChat: vi.fn(),
  deleteMessage: vi.fn(),
  saveJidMapping: vi.fn(),
  resolveDisplayName: vi.fn(),
  getChats: vi.fn(),
  getMessages: vi.fn(),
  getUnreadChats: vi.fn(),
  getAllJidsFor: vi.fn(),
  getMessageFromMe: vi.fn(),
}));

// Import AFTER vi.mock
import { getMyInfo } from "../whatsapp.js";
import * as db from "../db.js";

describe("getMyInfo cached profile fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns cached profile when socket is null and cache exists", () => {
    const mockProfile = {
      jid: "971525527198@s.whatsapp.net",
      lid_jid: null,
      name: "Test User",
    };
    (db.getUserProfile as any).mockReturnValue(mockProfile);

    const info = getMyInfo();
    expect(info.jid).toBe("971525527198@s.whatsapp.net");
    expect(info.name).toBe("Test User");
    expect(info.phone).toBe("971525527198"); // extracted from jid
    expect(info.lidJid).toBeNull();
  });

  it("returns cached profile with lid_jid when available", () => {
    const mockProfile = {
      jid: "971525527198@s.whatsapp.net",
      lid_jid: "971525527198@lid",
      name: "Test User",
    };
    (db.getUserProfile as any).mockReturnValue(mockProfile);

    const info = getMyInfo();
    expect(info.jid).toBe("971525527198@s.whatsapp.net");
    expect(info.lidJid).toBe("971525527198@lid");
    expect(info.name).toBe("Test User");
    expect(info.phone).toBe("971525527198");
  });

  it("returns 'You' as default name when cached name is null", () => {
    const mockProfile = {
      jid: "971525527198@s.whatsapp.net",
      lid_jid: null,
      name: null,
    };
    (db.getUserProfile as any).mockReturnValue(mockProfile);

    const info = getMyInfo();
    expect(info.name).toBe("You");
  });

  it("returns all null fields when no socket and no cache", () => {
    (db.getUserProfile as any).mockReturnValue(null);

    const info = getMyInfo();
    expect(info.jid).toBeNull();
    expect(info.name).toBeNull();
    expect(info.phone).toBeNull();
    expect(info.lidJid).toBeNull();
  });

  it("extracts phone number correctly from jid", () => {
    const mockProfile = {
      jid: "1234567890@s.whatsapp.net",
      lid_jid: null,
      name: "Another User",
    };
    (db.getUserProfile as any).mockReturnValue(mockProfile);

    const info = getMyInfo();
    expect(info.phone).toBe("1234567890");
  });

  it("returns null phone when jid is null", () => {
    (db.getUserProfile as any).mockReturnValue(null);

    const info = getMyInfo();
    expect(info.phone).toBeNull();
  });
});
