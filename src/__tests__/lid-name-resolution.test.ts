import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createFakeBaileysSocket, type FakeBaileysSocket } from "./helpers/fake-baileys.js";
import { closeTestDb, seedLidTestData, setupTestDb } from "./helpers/test-db.js";

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

describe("LID-aware name resolution", () => {
  let closeWhatsApp: () => Promise<void>;

  beforeAll(async () => {
    process.env.MIN_SEND_INTERVAL_MS = "0";
    process.env.SEND_JITTER_MS = "0";

    await setupTestDb();
    seedLidTestData();

    const whatsapp = await import("../whatsapp.js");
    closeWhatsApp = whatsapp.closeWhatsApp;
    await whatsapp.initWhatsApp();
    const socket = mockState.sockets.at(-1);
    if (!socket) throw new Error("Expected fake Baileys socket");
    socket.emitConnectionOpen();
  })

  afterAll(async () => {
    if (closeWhatsApp) {
      await closeWhatsApp();
    }
    closeTestDb();
  });

  it("getRecipientInfo resolves name via LID-to-phone mapping", async () => {
    const { getRecipientInfo } = await import("../whatsapp.js");

    // Call with LID JID
    const result = getRecipientInfo("169509591765046@lid");

    // Should resolve name from the phone JID's contact entry
    expect(result.name).toBe("Panama Equity");
    // Should return canonical phone JID
    expect(result.jid).toBe("50763345671@s.whatsapp.net");
    // Should have formatted phone
    expect(result.phone).toBe("50763345671");
  });

  it("getRecipientInfo returns canonical phone JID even when given LID", async () => {
    const { getRecipientInfo } = await import("../whatsapp.js");

    const result = getRecipientInfo("169509591765046@lid");

    // jid field should be the canonical phone JID, not the LID
    expect(result.jid).toBe("50763345671@s.whatsapp.net");
    expect(result.jid).not.toBe("169509591765046@lid");
  });

  it("getRecipientInfo works with phone JID input", async () => {
    const { getRecipientInfo } = await import("../whatsapp.js");

    const result = getRecipientInfo("50763345671@s.whatsapp.net");

    expect(result.name).toBe("Panama Equity");
    expect(result.jid).toBe("50763345671@s.whatsapp.net");
    expect(result.phone).toBe("50763345671");
  });

  it("resolveChatName resolves name via LID-to-phone mapping", async () => {
    const { resolveChatName } = await import("../whatsapp.js");

    // Call with LID JID
    const name = await resolveChatName("169509591765046@lid");

    // Should resolve name from the phone JID's contact entry
    expect(name).toBe("Panama Equity");
  });

  it("resolveChatName works with phone JID input", async () => {
    const { resolveChatName } = await import("../whatsapp.js");

    const name = await resolveChatName("50763345671@s.whatsapp.net");

    expect(name).toBe("Panama Equity");
  });
});
