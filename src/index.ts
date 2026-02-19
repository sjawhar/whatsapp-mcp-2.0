import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs";
import path from "path";
import { initDb, closeDb } from "./db.js";
import { initWhatsApp, closeWhatsApp, resolveConnectionAsReadOnly } from "./whatsapp.js";
import { registerTools } from "./tools.js";

const __project_root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const LOCK_FILE = path.join(__project_root, "store", ".whatsapp.lock");

/**
 * Try to acquire a file lock for the WhatsApp connection.
 * Only one process should connect to WhatsApp at a time to avoid status 515/440.
 * Returns true if we got the lock.
 */
function acquireWhatsAppLock(): boolean {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0); // throws if process is dead
      return false; // another instance is alive
    } catch {
      console.error(`Stale lock file found (PID ${pid} is dead) — clearing and taking over`);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}

function releaseWhatsAppLock(): void {
  try {
    // Only release if we own the lock
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

async function main() {
  console.error("Starting WhatsApp MCP Server...");

  // 1. Initialize SQLite database (synchronous, instant).
  initDb();

  // 2. Create MCP server and connect to stdio transport FIRST
  //    so the client doesn't time out waiting for the initialize handshake.
  const server = new McpServer({
    name: "whatsapp",
    version: "1.0.0",
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running on stdio");

  // 3. Initialize WhatsApp in the background — but only if no other instance
  //    already owns the WhatsApp connection. This prevents status 515/440
  //    when Claude Desktop spawns multiple MCP server instances.
  if (acquireWhatsAppLock()) {
    console.error("WhatsApp lock acquired — connecting...");
    initWhatsApp().catch((err) => {
      console.error("Failed to initialize WhatsApp:", err);
    });
  } else {
    console.error("Another instance owns the WhatsApp connection — running as read-only from SQLite");
    resolveConnectionAsReadOnly();
  }

  // 4. Graceful shutdown
  const shutdown = async () => {
    console.error("Shutting down...");
    await closeWhatsApp();
    releaseWhatsAppLock();
    closeDb();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
