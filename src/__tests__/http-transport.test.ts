import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer, type HttpServerController } from "../http-server.js";

const API_KEY = "test-api-key";

describe("HTTP MCP transport", () => {
  let controller: HttpServerController | undefined;

  afterEach(async () => {
    await controller?.closeHttpServer();
    controller = undefined;
  });

  it("rejects requests without a valid bearer token", async () => {
    controller = await createHttpServer(0, "127.0.0.1", API_KEY);
    const baseUrl = `http://127.0.0.1:${controller.port}`;

    const postResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    const getResponse = await fetch(`${baseUrl}/mcp`, { method: "GET" });
    const deleteResponse = await fetch(`${baseUrl}/mcp`, { method: "DELETE" });

    expect(postResponse.status).toBe(401);
    expect(getResponse.status).toBe(401);
    expect(deleteResponse.status).toBe(401);
  });

  it("creates and uses a stateful session and supports DELETE termination", async () => {
    controller = await createHttpServer(0, "127.0.0.1", API_KEY);
    const baseUrl = `http://127.0.0.1:${controller.port}`;
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: {
          authorization: `Bearer ${API_KEY}`,
        },
      },
    });
    const client = new Client({ name: "http-transport-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();

      expect(tools.tools.length).toBeGreaterThan(0);
      expect(transport.sessionId).toBeTruthy();

      await transport.terminateSession();

      const deletedSessionResponse = await fetch(`${baseUrl}/mcp`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${API_KEY}`,
          accept: "text/event-stream",
          "mcp-session-id": transport.sessionId!,
        },
      });

      expect(deletedSessionResponse.status).toBe(404);
    } finally {
      await client.close();
    }
  });

  it("opens an SSE stream on GET /mcp for a valid session", async () => {
    controller = await createHttpServer(0, "127.0.0.1", API_KEY);
    const baseUrl = `http://127.0.0.1:${controller.port}`;
    const initializeResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "http-test-client", version: "1.0.0" },
        },
      }),
    });

    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const sseResponse = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        accept: "text/event-stream",
        "mcp-session-id": sessionId as string,
      },
    });

    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers.get("content-type") || "").toContain("text/event-stream");

    sseResponse.body?.cancel();
  });
});
