import fs from "node:fs";
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

describe("integration: contacts flow", () => {
  const vcfPath = "/home/sami/projects/whatsapp-mcp/contacts/contacts.vcf";

  let originalVcf: string | null;
  let server: McpServer;
  let client: Client;
  let closeWhatsApp: () => Promise<void>;

  beforeAll(async () => {
    process.env.MIN_SEND_INTERVAL_MS = "0";
    process.env.SEND_JITTER_MS = "0";

    fs.mkdirSync(path.dirname(vcfPath), { recursive: true });
    originalVcf = fs.existsSync(vcfPath) ? fs.readFileSync(vcfPath, "utf8") : null;
    fs.writeFileSync(
      vcfPath,
      [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Alice Updated From VCF",
        "TEL:+1 555 000 1111",
        "END:VCARD",
        "",
      ].join("\n")
    );

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

    if (originalVcf === null) {
      fs.rmSync(vcfPath, { force: true });
    } else {
      fs.writeFileSync(vcfPath, originalVcf);
    }
  });

  it("updates/searches contacts, returns own profile, and syncs from VCF", async () => {
    const updated = (await client.callTool({
      name: "update_contact",
      arguments: {
        jid: "15550001111",
        name: "Alice Integration",
      },
    })) as RawToolResult;
    expect(updated.isError).toBeFalsy();
    expect(parseToolJson(updated)).toMatchObject({
      success: true,
      jid: "15550001111@s.whatsapp.net",
      name: "Alice Integration",
    });

    const searched = (await client.callTool({
      name: "search_contacts",
      arguments: {
        query: "Integration",
      },
    })) as RawToolResult;
    expect(searched.isError).toBeFalsy();
    expect(parseToolJson(searched)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jid: "15550001111@s.whatsapp.net",
          name: "Alice Integration",
        }),
      ])
    );

    const profile = (await client.callTool({
      name: "get_my_profile",
      arguments: {},
    })) as RawToolResult;
    expect(profile.isError).toBeFalsy();
    expect(parseToolJson(profile)).toMatchObject({
      jid: "15559990000@s.whatsapp.net",
      lidJid: "15559990000@lid",
      name: "Test User",
      phone: "15559990000",
    });

    const synced = (await client.callTool({
      name: "sync_contacts",
      arguments: {},
    })) as RawToolResult;
    expect(synced.isError).toBeFalsy();
    expect(parseToolJson(synced)).toMatchObject({
      success: true,
      totalParsed: 1,
      totalUpdated: expect.any(Number),
      vcfPath: expect.stringContaining("contacts.vcf"),
    });
  });
});
