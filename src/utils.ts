/**
 * Normalize a phone number or JID into proper WhatsApp JID format.
 * Accepts: "1234567890", "+1234567890", "1234567890@s.whatsapp.net"
 * Groups are passed through as-is if they end with @g.us
 */
export function toJid(input: string): string {
  const trimmed = input.trim();

  // Already a valid JID
  if (trimmed.endsWith("@s.whatsapp.net") || trimmed.endsWith("@g.us") || trimmed.endsWith("@lid")) {
    return trimmed;
  }

  // Strip non-numeric characters (like +, spaces, dashes)
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) {
    throw new Error(`Invalid phone number or JID: "${input}"`);
  }

  return `${digits}@s.whatsapp.net`;
}

/**
 * Extract the readable phone number or group ID from a JID.
 */
export function fromJid(jid: string): string {
  return jid.replace(/@s\.whatsapp\.net$/, "").replace(/@g\.us$/, " (group)").replace(/@lid$/, "");
}

/**
 * Format a Unix timestamp (seconds) to a readable date string.
 */
export function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return "unknown";
  const n = typeof ts === "number" ? ts : Number(ts);
  return new Date(n * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/**
 * Format a SQLite message row for MCP tool responses.
 */
export function formatMessageRow(row: {
  id: string;
  chat_jid: string;
  from_me: number;
  sender_jid: string | null;
  sender_name: string | null;
  type: string;
  text: string | null;
  timestamp: number;
  has_media: number;
}): Record<string, unknown> {
  return {
    id: row.id,
    from: row.from_me ? "me" : (row.sender_name || row.sender_jid || row.chat_jid),
    fromMe: !!row.from_me,
    type: row.type,
    text: row.text || undefined,
    timestamp: formatTimestamp(row.timestamp),
    hasMedia: !!row.has_media,
  };
}

/**
 * Detect media MIME type from a file extension.
 */
export function mimeFromExtension(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    zip: "application/zip",
  };
  return map[ext || ""] || "application/octet-stream";
}

/**
 * Detect the Baileys media type key from MIME type for sending files.
 */
export function mediaCategoryFromMime(mime: string): "image" | "video" | "audio" | "document" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}
