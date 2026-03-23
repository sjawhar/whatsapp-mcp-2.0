# WhatsApp MCP Server

A Model Context Protocol (MCP) server that connects to WhatsApp via [Baileys](https://github.com/WhiskeySockets/Baileys), providing AI with the ability to manage WhatsApp. This is a security-hardened fork of [karlfoster/whatsapp-mcp-2.0](https://github.com/karlfoster/whatsapp-mcp-2.0).

## ⚠️ WARNING

**This project uses the UNOFFICIAL WhatsApp Web API (Baileys).**
WhatsApp may ban accounts using unofficial clients.
**USE A DEDICATED BURNER NUMBER** — never use your personal number.
The authors take no responsibility for account bans or any other consequences of using this software.

## What This Is

This is a fork of `karlfoster/whatsapp-mcp-2.0` with significant security hardening and operational improvements. It allows an AI assistant (like Claude) to:
- List and search chats, contacts, and messages.
- Send text messages and files (images, videos, documents, audio).
- Download media from received messages.
- Transcribe voice notes via Whisper-compatible APIs.
- Sync phone contacts from VCF files.

## Setup

1.  **Clone the repository**:
    ```bash
    git clone <repo-url>
    cd whatsapp-mcp
    ```

2.  **Install dependencies**:
    ```bash
    npm ci
    ```

3.  **Configure environment variables**:
    Create a `.env` file or set them in your MCP client configuration (see below).

4.  **Run the server**:
    ```bash
    npm run dev
    ```

5.  **Scan the QR code**:
    On first run, a QR code will appear in your terminal. Scan it with WhatsApp on your phone:
    **WhatsApp > Settings > Linked Devices > Link a Device**

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `ALLOWED_SEND_DIR` | `./uploads/` | Directory for outbound file sends. |
| `MAX_SEND_FILE_SIZE` | `67108864` (64MB) | Max file size for `send_file`. |
| `DOWNLOADS_DIR` | `./downloads/` | Directory for downloaded media. |
| `CONTACTS_DIR` | `./contacts/` | Base directory for VCF imports. |
| `WHISPER_API_URL` | (none) | Whisper API endpoint for transcription. |
| `WHISPER_API_KEY` | (none) | API key for Whisper. |
| `WHISPER_MODEL` | `whisper-large-v3-turbo` | Model name for transcription. |
| `ZOMBIE_TIMEOUT_MS` | `120000` (2min) | Silence before zombie connection detection. |
| `MAX_SEND_FAILURES` | `3` | Consecutive failures before reconnect. |
| `MIN_SEND_INTERVAL_MS` | `3000` (3s) | Minimum delay between sends. |
| `SEND_JITTER_MS` | `2000` (2s) | Random jitter added to send delay. |
| `MAX_RECONNECT_ATTEMPTS` | `10` | Max reconnect attempts before giving up. |

## Storage Locations

- `auth_info/`: WhatsApp authentication credentials (DO NOT commit).
- `data/`: SQLite database containing messages, chats, and contacts.
- `store/`: Baileys message store and `.whatsapp.lock` file.
- `uploads/`: Files to send (only files in this directory can be sent via `send_file`).
- `downloads/`: Downloaded media files.
- `contacts/`: VCF files for contact import.

## Running Tests

This project uses Vitest for testing.

```bash
# Run all tests
npx vitest run

# Run tests with coverage
npx vitest run --coverage
```

## Known Limitations

- **No FTS5**: SQLite full-text search is not used; substring search (`LIKE`) is used instead.
- **No Read Receipts**: The server does not send read receipts.
- **No Reactions**: Message reactions are not supported.
- **No Stories**: WhatsApp Stories/Status updates are not accessible.

## Security Changes (What changed from upstream)

- **Path Traversal Protection**: Strict containment checks for `send_file` and `download_media` using resolved paths.
- **SSRF Validation**: `WHISPER_API_URL` is validated to prevent SSRF attacks (rejects localhost and private IP ranges).
- **Atomic Lock File**: Prevents multiple instances from connecting to the same WhatsApp account simultaneously.
- **Strict Filename Sanitization**: All filenames are sanitized to prevent injection and traversal.
- **Bounded Memory Caches**: Prevents unbounded memory growth in Baileys message retry and device tracking.
- **Pre-key Pruning**: Automatically prunes old pre-keys to prevent disk bloat.
- **Removed `reply_spam`**: Removed the UAE-specific spam reply tool for better general-purpose use.
- **Streamed Uploads**: `send_file` uses streams instead of loading full files into memory.

## Available Tools

- `list_chats`: List chats sorted by last activity.
- `get_chat`: Get chat details with recent messages.
- `list_messages`: Get messages from a chat.
- `search_messages`: Substring search across messages.
- `search_contacts`: Find contacts by name or phone number.
- `get_message_context`: Get messages surrounding a specific message.
- `get_my_profile`: Get your own JID and profile info.
- `update_contact`: Update a contact's display name.
- `sync_contacts`: Import phone contacts from a VCF file.
- `send_message`: Send a text message (requires confirmation).
- `send_file`: Send a media file (requires confirmation).
- `delete_message`: Delete a message (requires confirmation).
- `delete_chat`: Delete an entire chat (requires confirmation).
- `download_media`: Download media from a message to disk.
- `transcribe_voice_note`: Transcribe a voice note to text.

## License

MIT
