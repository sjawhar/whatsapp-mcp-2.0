import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getRecentMessages } from "./db.js";

export const NEW_MESSAGES_RESOURCE_URI = "whatsapp://messages/new";

type ResourceUpdateSender = (uri: string) => Promise<void> | void;

export type ResourceSubscriptionStore = {
  registerSession: (sessionId: string, sendResourceUpdated: ResourceUpdateSender) => void;
  removeSession: (sessionId: string) => void;
  subscribe: (sessionId: string, uri: string) => void;
  unsubscribe: (sessionId: string, uri: string) => void;
  notifyResourceUpdated: (uri: string) => Promise<void>;
  getSubscriberCount: (uri: string) => number;
};

export function createResourceSubscriptionStore(): ResourceSubscriptionStore {
  const subscriptions = new Map<string, Set<string>>();
  const sessionSenders = new Map<string, ResourceUpdateSender>();

  const subscribe = (sessionId: string, uri: string): void => {
    const sessionIds = subscriptions.get(uri) ?? new Set<string>();
    sessionIds.add(sessionId);
    subscriptions.set(uri, sessionIds);
  };

  const unsubscribe = (sessionId: string, uri: string): void => {
    const sessionIds = subscriptions.get(uri);
    if (!sessionIds) {
      return;
    }

    sessionIds.delete(sessionId);
    if (sessionIds.size === 0) {
      subscriptions.delete(uri);
    }
  };

  const removeSession = (sessionId: string): void => {
    sessionSenders.delete(sessionId);

    for (const [uri, sessionIds] of subscriptions) {
      sessionIds.delete(sessionId);
      if (sessionIds.size === 0) {
        subscriptions.delete(uri);
      }
    }
  };

  return {
    registerSession(sessionId, sendResourceUpdated) {
      sessionSenders.set(sessionId, sendResourceUpdated);
    },
    removeSession,
    subscribe,
    unsubscribe,
    async notifyResourceUpdated(uri) {
      const sessionIds = subscriptions.get(uri);
      if (!sessionIds || sessionIds.size === 0) {
        return;
      }

      for (const sessionId of [...sessionIds]) {
        const sender = sessionSenders.get(sessionId);
        if (!sender) {
          sessionIds.delete(sessionId);
          continue;
        }

        await sender(uri);
      }

      if (sessionIds.size === 0) {
        subscriptions.delete(uri);
      }
    },
    getSubscriberCount(uri) {
      return subscriptions.get(uri)?.size ?? 0;
    },
  };
}

export function registerResources(server: McpServer): void {
  server.resource(
    "new_messages",
    NEW_MESSAGES_RESOURCE_URI,
    async (uri) => {
      const messages = getRecentMessages(10);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(messages),
          },
        ],
      };
    }
  );
}

export function registerResourceSubscriptionHandlers(
  server: McpServer,
  sessionId: string,
  store: ResourceSubscriptionStore
): void {
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    store.subscribe(sessionId, request.params.uri);
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    store.unsubscribe(sessionId, request.params.uri);
    return {};
  });
}
