import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type JsonLike = Record<string, unknown> | unknown[] | string | number | boolean | null;

export type McpTestClient = {
  listTools: () => Promise<string[]>;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<JsonLike>;
  close: () => Promise<void>;
};

function extractToolPayload(result: any): JsonLike {
  const textPart = result.content?.find(
    (entry: { type?: string; text?: string }) => entry.type === "text" && typeof entry.text === "string"
  );
  const text = textPart?.text ?? "";

  if (result.isError) {
    throw new Error(text || "Tool call failed");
  }

  try {
    return JSON.parse(text) as JsonLike;
  } catch {
    return text;
  }
}

export async function createMcpTestClient(): Promise<McpTestClient> {
  const server = new McpServer({ name: "whatsapp-test", version: "1.0.0" });
  const { registerTools } = await import("../../tools.js");
  const { resolveConnectionAsReadOnly } = await import("../../whatsapp.js");
  registerTools(server);
  resolveConnectionAsReadOnly();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "whatsapp-test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    async listTools() {
      const result = await client.listTools();
      return result.tools.map((tool) => tool.name);
    },

    async callTool(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      return extractToolPayload(result);
    },

    async close() {
      await Promise.all([client.close(), server.close()]);
    },
  };
}
