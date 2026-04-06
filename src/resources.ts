import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getCanonicalJid, getChats, getMessages, getRecentMessages, searchContacts } from "./db.js";
import { fromJid, toJid } from "./utils.js";

export const NEW_MESSAGES_RESOURCE_URI = "whatsapp://messages/new";
const CHAT_MESSAGES_TEMPLATE = "whatsapp://chats/{contact}/messages";

type ChatListEntry = {
  jid: string;
  name?: string | null;
  isGroup?: boolean;
};

type ContactSearchEntry = {
  jid: string;
  phone?: string | null;
  isGroup?: boolean;
};

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

export function chatResourceUri(jid: string): string {
  const canonical = getCanonicalJid(jid);
  const phone = fromJid(canonical);
  return `whatsapp://chats/${phone}/messages`;
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

  server.resource(
    "chat_messages",
    new ResourceTemplate(CHAT_MESSAGES_TEMPLATE, {
      list: async () => {
        const chats = getChats(undefined, 50) as ChatListEntry[];
        return {
          resources: chats
            .filter((chat) => !chat.isGroup)
            .map((chat) => {
              const phone = fromJid(getCanonicalJid(String(chat.jid)));
              return {
                uri: chatResourceUri(String(chat.jid)),
                name: `${chat.name || phone} messages`,
              };
            }),
        };
      },
      complete: {
        contact: async (value: string) => {
          const contacts = searchContacts(value) as ContactSearchEntry[];
          return [...new Set(
            contacts
              .filter((contact) => !contact.isGroup)
              .map((contact) => String(contact.phone || fromJid(getCanonicalJid(String(contact.jid)))))
              .filter(Boolean)
          )];
        },
      },
    }),
    { mimeType: "application/json" },
    async (uri, { contact }) => {
      const jid = toJid(String(contact));
      const messages = getMessages(jid, 20);
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
