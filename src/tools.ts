import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getChats,
  getChat,
  getMessages,
  searchMessages,
  searchContacts,
  getMessageContext,
  getRecipientInfo,
  sendTextMessage,
  sendFileMessage,
  downloadMessageMedia,
  transcribeVoiceNote,
  deleteMessage,
  deleteChat,
  updateContact,
  getMyInfo,
} from "./whatsapp.js";
import { getDb } from "./db.js";
import { importContactsFromVcf } from "./import-contacts.js";

/**
 * Register all WhatsApp MCP tools on the server.
 */
export function registerTools(server: McpServer): void {
  // ─── Reading Tools ──────────────────────────────────────────

  server.tool(
    "list_chats",
    "List all WhatsApp chats sorted by last activity. Optionally filter by name.",
    {
      nameFilter: z.string().optional().describe("Filter chats by name (case-insensitive substring match)"),
      limit: z.number().min(1).max(100).default(20).describe("Max number of chats to return"),
    },
    async ({ nameFilter, limit }) => {
      try {
        const chats = await getChats(nameFilter);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(chats.slice(0, limit), null, 2),
            },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_chat",
    "Get details for a specific chat including recent messages.",
    {
      jid: z.string().describe("Chat JID (phone@s.whatsapp.net) or phone number"),
    },
    async ({ jid }) => {
      try {
        const chat = await getChat(jid);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(chat, null, 2) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_messages",
    "Get messages from a specific chat. Returns most recent messages first.",
    {
      jid: z.string().describe("Chat JID or phone number"),
      limit: z.number().min(1).max(100).default(50).describe("Number of messages to return"),
    },
    async ({ jid, limit }) => {
      try {
        const messages = await getMessages(jid, limit);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(messages, null, 2) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "search_messages",
    "Full-text search across messages. Can search in a specific chat or across all chats.",
    {
      query: z.string().describe("Text to search for (case-insensitive)"),
      jid: z.string().optional().describe("Optional: limit search to a specific chat JID"),
    },
    async ({ query, jid }) => {
      try {
        const results = await searchMessages(query, jid);
        return {
          content: [
            {
              type: "text" as const,
              text: results.length
                ? JSON.stringify(results, null, 2)
                : `No messages found matching "${query}"`,
            },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "search_contacts",
    "Find contacts by name or phone number.",
    {
      query: z.string().describe("Name or phone number to search for"),
    },
    async ({ query }) => {
      try {
        const results = await searchContacts(query);
        return {
          content: [
            {
              type: "text" as const,
              text: results.length
                ? JSON.stringify(results, null, 2)
                : `No contacts found matching "${query}"`,
            },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_message_context",
    "Get messages surrounding a specific message for context.",
    {
      jid: z.string().describe("Chat JID or phone number"),
      messageId: z.string().describe("ID of the target message"),
      count: z.number().min(1).max(20).default(5).describe("Number of messages before and after"),
    },
    async ({ jid, messageId, count }) => {
      try {
        const context = await getMessageContext(jid, messageId, count);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(context, null, 2) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ─── Identity Tools ─────────────────────────────────────────

  server.tool(
    "get_my_profile",
    "Get the authenticated WhatsApp user's own phone number, JID, LID JID, and display name. Use this to identify 'me' for sending messages to yourself.",
    {},
    async () => {
      try {
        const info = getMyInfo();
        if (!info.jid) {
          return {
            content: [{
              type: "text" as const,
              text: "Not connected yet — WhatsApp identity not available. Try again in a moment.",
            }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ─── Contact Management Tools ───────────────────────────────

  server.tool(
    "update_contact",
    "Update or set the display name for a contact. Updates both the contact record and chat listing so the name appears immediately everywhere.",
    {
      jid: z.string().describe("Contact JID (phone@s.whatsapp.net) or phone number"),
      name: z.string().describe("The display name to set for this contact"),
    },
    async ({ jid, name }) => {
      try {
        const result = await updateContact(jid, name);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "sync_contacts",
    "Import phone contacts from the contacts/contacts.vcf file into the database. " +
    "Matches phone numbers from the VCF to existing WhatsApp JIDs and updates their display names. " +
    "Use this after a fresh QR code scan to populate contact names from your address book.",
    {},
    async () => {
      try {
        const result = importContactsFromVcf(getDb());
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ─── Writing Tools ──────────────────────────────────────────

  server.tool(
    "send_message",
    "Send a text message to a WhatsApp contact or group. " +
    "First call without confirmed=true returns a preview for user approval. " +
    "Call again with confirmed=true to actually send.",
    {
      jid: z.string().describe("Recipient JID (phone@s.whatsapp.net), group JID, or phone number"),
      text: z.string().describe("Message text to send"),
      confirmed: z.boolean().default(false).describe("Set to true to confirm and send the message. When false, returns a preview for user approval."),
    },
    async ({ jid, text, confirmed }) => {
      try {
        const recipient = getRecipientInfo(jid);

        if (!confirmed) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "confirmation_required",
                to: recipient.name || "Unknown contact",
                phone: recipient.phone,
                jid: recipient.jid,
                message: text,
                instruction: "Show the user who this message will be sent to, their number, and the message content. Ask them to confirm before calling send_message again with confirmed=true.",
              }, null, 2),
            }],
          };
        }

        const result = await sendTextMessage(jid, text);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "send_file",
    "Send an image, video, audio, or document file to a WhatsApp contact or group.",
    {
      jid: z.string().describe("Recipient JID or phone number"),
      filePath: z.string().describe("Absolute path to the file to send"),
      caption: z.string().optional().describe("Optional caption for the file"),
    },
    async ({ jid, filePath, caption }) => {
      try {
        const result = await sendFileMessage(jid, filePath, caption);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );


  server.tool(
    "delete_message",
    "Delete a message for everyone in the chat. Removes it from WhatsApp servers and the local database. For messages you didn't send, this only works in groups where you are an admin. " +
    "First call without confirmed=true returns a preview for user approval. " +
    "Call again with confirmed=true to actually delete.",
    {
      jid: z.string().describe("Chat JID or phone number where the message is"),
      messageId: z.string().describe("ID of the message to delete"),
      confirmed: z.boolean().default(false).describe("Set to true to confirm and delete the message. When false, returns a preview for user approval."),
    },
    async ({ jid, messageId, confirmed }) => {
      try {
        if (!confirmed) {
          const recipient = getRecipientInfo(jid);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "confirmation_required",
                chat: recipient.name || "Unknown contact",
                phone: recipient.phone,
                jid: recipient.jid,
                messageId,
                warning: "This will delete the message for everyone.",
                instruction: "Show the user the chat name, number, and message ID. Ask them to confirm before calling delete_message again with confirmed=true.",
              }, null, 2),
            }],
          };
        }

        const result = await deleteMessage(jid, messageId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "delete_chat",
    "Delete an entire chat from WhatsApp. Removes the chat from your chat list and deletes all messages locally. " +
    "First call without confirmed=true returns a preview for user approval. " +
    "Call again with confirmed=true to actually delete.",
    {
      jid: z.string().describe("Chat JID or phone number of the chat to delete"),
      confirmed: z.boolean().default(false).describe("Set to true to confirm and delete the chat. When false, returns a preview for user approval."),
    },
    async ({ jid, confirmed }) => {
      try {
        if (!confirmed) {
          const recipient = getRecipientInfo(jid);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "confirmation_required",
                chat: recipient.name || "Unknown contact",
                phone: recipient.phone,
                jid: recipient.jid,
                warning: "This will permanently delete the entire chat from your WhatsApp, including all messages.",
                instruction: "Show the user the chat name and number. Ask them to confirm before calling delete_chat again with confirmed=true.",
              }, null, 2),
            }],
          };
        }

        const result = await deleteChat(jid);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ─── Media Tools ────────────────────────────────────────────

  server.tool(
    "download_media",
    "Download media (voice notes, images, videos, documents) from a received message to local disk. Returns the file path so you can read/process the content directly.",
    {
      jid: z.string().describe("Chat JID or phone number where the message is"),
      messageId: z.string().describe("ID of the message containing media"),
    },
    async ({ jid, messageId }) => {
      try {
        const result = await downloadMessageMedia(jid, messageId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "transcribe_voice_note",
    "Transcribe a voice note to text. Downloads the audio from WhatsApp, " +
    "sends it to a speech-to-text API, and returns the transcription. " +
    "Requires WHISPER_API_KEY and WHISPER_API_URL environment variables. " +
    "Results are cached so repeated calls for the same message are instant.",
    {
      jid: z.string().describe("Chat JID or phone number where the voice note is"),
      messageId: z.string().describe("ID of the voice note message"),
    },
    async ({ jid, messageId }) => {
      try {
        const result = await transcribeVoiceNote(jid, messageId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
