import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, seedTestDb, setupTestDb } from "./helpers/test-db.js";
import { createMcpTestClient, type McpTestClient } from "./helpers/mcp-test-client.js";

describe("MCP smoke test", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    await setupTestDb();
    seedTestDb();
    client = await createMcpTestClient();
  });

  afterAll(async () => {
    await client?.close();
    closeTestDb();
  });

  it("connects MCP client, exposes 16 tools, and returns seeded chats", async () => {
    const tools = await client.listTools();
    expect(tools).toHaveLength(16);

    const listChats = await client.callTool("list_chats", { limit: 20 });
    expect(Array.isArray(listChats)).toBe(true);
    expect(listChats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jid: "15550001111@s.whatsapp.net",
          name: "Alice Test",
        }),
      ])
    );
  });
});
