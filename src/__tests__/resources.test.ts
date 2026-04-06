import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { closeTestDb, seedTestDb, setupTestDb } from "./helpers/test-db.js";
import { createHttpServer, type HttpServerController } from "../http-server.js";
import {
  NEW_MESSAGES_RESOURCE_URI,
  chatResourceUri,
  createResourceSubscriptionStore,
  registerResourceSubscriptionHandlers,
  registerResources,
} from "../resources.js";

const API_KEY = "test-api-key";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("MCP resources and subscriptions", () => {
  let httpController: HttpServerController | undefined;

  beforeEach(async () => {
    await setupTestDb();
    seedTestDb();
  });

  afterEach(async () => {
    await httpController?.closeHttpServer();
    httpController = undefined;
    closeTestDb();
  });

  it("registers whatsapp://messages/new and returns recent messages", async () => {
    const store = createResourceSubscriptionStore();
    const sessionId = "in-memory-session";
    const server = new McpServer(
      { name: "whatsapp-test", version: "1.0.0" },
      { capabilities: { resources: { subscribe: true, listChanged: true } } }
    );
    registerResources(server);
    store.registerSession(sessionId, (uri) => server.server.sendResourceUpdated({ uri }));
    registerResourceSubscriptionHandlers(server, sessionId, store);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-test-client", version: "1.0.0" });

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const listed = await client.listResources();
      expect(listed.resources).toEqual(
        expect.arrayContaining([expect.objectContaining({ uri: NEW_MESSAGES_RESOURCE_URI })])
      );

      const resource = await client.readResource({ uri: NEW_MESSAGES_RESOURCE_URI });
      const firstContent = resource.contents[0];
      const payloadText = firstContent && "text" in firstContent ? firstContent.text : "[]";
      const payload = JSON.parse(payloadText) as Array<Record<string, unknown>>;

      expect(payload.length).toBeGreaterThan(0);
      expect(payload.length).toBeLessThanOrEqual(10);
      expect(payload[0]).toEqual(expect.objectContaining({ chat: "15550001111@s.whatsapp.net" }));
    } finally {
      await Promise.all([client.close(), server.close()]);
      store.removeSession(sessionId);
    }
  });

  it("builds canonical per-chat URIs and reads messages for a conversation resource", async () => {
    const { seedLidTestData } = await import("./helpers/test-db.js");
    seedLidTestData();

    const store = createResourceSubscriptionStore();
    const sessionId = "in-memory-session";
    const server = new McpServer(
      { name: "whatsapp-test", version: "1.0.0" },
      { capabilities: { resources: { subscribe: true, listChanged: true } } }
    );
    registerResources(server);
    store.registerSession(sessionId, (uri) => server.server.sendResourceUpdated({ uri }));
    registerResourceSubscriptionHandlers(server, sessionId, store);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-chat-client", version: "1.0.0" });

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      expect(chatResourceUri("169509591765046@lid")).toBe("whatsapp://chats/50763345671/messages");
      expect(chatResourceUri("50763345671@s.whatsapp.net")).toBe("whatsapp://chats/50763345671/messages");

      const listed = await client.listResources();
      expect(listed.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ uri: "whatsapp://chats/15550001111/messages" }),
          expect.objectContaining({ uri: "whatsapp://chats/50763345671/messages" }),
        ])
      );

      const resource = await client.readResource({ uri: "whatsapp://chats/50763345671/messages" });
      const firstContent = resource.contents[0];
      const payloadText = firstContent && "text" in firstContent ? firstContent.text : "[]";
      const payload = JSON.parse(payloadText) as Array<Record<string, unknown>>;

      expect(payload.map((message) => message.text)).toEqual(
        expect.arrayContaining([
          "Can you send the deposit?",
          "Looking at the apartment tomorrow",
          "Sure, sending now",
        ])
      );
    } finally {
      await Promise.all([client.close(), server.close()]);
      store.removeSession(sessionId);
    }
  });

  it("subscribes and unsubscribes via MCP resource handlers", async () => {
    const store = createResourceSubscriptionStore();
    const sessionId = "in-memory-session";
    const server = new McpServer(
      { name: "whatsapp-test", version: "1.0.0" },
      { capabilities: { resources: { subscribe: true, listChanged: true } } }
    );
    registerResources(server);
    store.registerSession(sessionId, (uri) => server.server.sendResourceUpdated({ uri }));
    registerResourceSubscriptionHandlers(server, sessionId, store);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscribe-client", version: "1.0.0" });
    const updates: string[] = [];

    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
      updates.push(notification.params.uri);
    });

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      await client.subscribeResource({ uri: NEW_MESSAGES_RESOURCE_URI });
      expect(store.getSubscriberCount(NEW_MESSAGES_RESOURCE_URI)).toBe(1);

      await store.notifyResourceUpdated(NEW_MESSAGES_RESOURCE_URI);
      await delay(25);
      expect(updates).toEqual([NEW_MESSAGES_RESOURCE_URI]);

      await client.unsubscribeResource({ uri: NEW_MESSAGES_RESOURCE_URI });
      expect(store.getSubscriberCount(NEW_MESSAGES_RESOURCE_URI)).toBe(0);

      await store.notifyResourceUpdated(NEW_MESSAGES_RESOURCE_URI);
      await delay(25);
      expect(updates).toEqual([NEW_MESSAGES_RESOURCE_URI]);
    } finally {
      await Promise.all([client.close(), server.close()]);
      store.removeSession(sessionId);
    }
  });

  it("cleans up subscriptions after HTTP session termination", async () => {
    const store = createResourceSubscriptionStore();
    httpController = await createHttpServer(0, "127.0.0.1", API_KEY, store);

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpController.port}/mcp`), {
      requestInit: {
        headers: {
          authorization: `Bearer ${API_KEY}`,
        },
      },
    });
    const client = new Client({ name: "http-resource-client", version: "1.0.0" });

    try {
      await client.connect(transport);
      await client.subscribeResource({ uri: NEW_MESSAGES_RESOURCE_URI });

      expect(store.getSubscriberCount(NEW_MESSAGES_RESOURCE_URI)).toBe(1);

      await transport.terminateSession();
      await delay(25);

      expect(store.getSubscriberCount(NEW_MESSAGES_RESOURCE_URI)).toBe(0);
    } finally {
      await client.close();
    }
  });
});
