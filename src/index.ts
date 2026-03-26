#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs";
import { initDb, closeDb } from "./db.js";
import { initWhatsApp, closeWhatsApp, resolveConnectionAsReadOnly } from "./whatsapp.js";
import { registerTools } from "./tools.js";
import { acquireWhatsAppLock, releaseWhatsAppLock } from "./lock.js";
import { LOCK_FILE, DATA_DIR } from "./paths.js";
console.error(`Data directory: ${DATA_DIR}`);

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

  // Detect parent death via two mechanisms:
  // 1. stdin EOF — works when process is spawned directly (not via npm wrapper chain)
  process.stdin.on('end', () => {
    console.error('stdin closed (parent disconnected) — shutting down');
    shutdown();
  });
  // 2. Parent PID polling — catches cases where npm/sh wrapper absorbs the signal
  //    but the actual parent (OpenCode) is gone. On Linux, orphaned processes get
  //    reparented to PID 1 (init/systemd).
  //    Note: process.ppid is cached at startup and doesn't update, so we read
  //    the live value from /proc/self/stat.
  const originalPpid = process.ppid;
  const getLivePpid = (): number => {
    try {
      const stat = fs.readFileSync('/proc/self/stat', 'utf8');
      return parseInt(stat.split(' ')[3], 10);
    } catch {
      return process.ppid; // Fallback for non-Linux
    }
  };
  const parentWatchdog = setInterval(() => {
    const currentPpid = getLivePpid();
    if (currentPpid !== originalPpid) {
      console.error(`Parent changed (${originalPpid} → ${currentPpid}) — shutting down`);
      clearInterval(parentWatchdog);
      shutdown();
    }
  }, 5_000);

  // 3. Initialize WhatsApp in the background — but only if no other instance
  //    already owns the WhatsApp connection. This prevents status 515/440
  //    when the host spawns multiple MCP server instances.
  if (acquireWhatsAppLock(LOCK_FILE)) {
    console.error("WhatsApp lock acquired — connecting...");
    initWhatsApp().catch((err) => {
      console.error("Failed to initialize WhatsApp:", err);
    });
  } else {
    console.error("Another instance owns the WhatsApp connection — running as read-only from SQLite");
    resolveConnectionAsReadOnly();

    // Periodically check if the lock holder died — if so, take over
    const lockRetryInterval = setInterval(() => {
      if (acquireWhatsAppLock(LOCK_FILE)) {
        console.error("Lock holder died — upgrading to read-write mode");
        clearInterval(lockRetryInterval);
        initWhatsApp().catch((err) => {
          console.error("Failed to initialize WhatsApp after lock takeover:", err);
        });
      }
    }, 10_000); // Check every 10 seconds

    // Clean up the interval on shutdown
    process.on("SIGINT", () => clearInterval(lockRetryInterval));
    process.on("SIGTERM", () => clearInterval(lockRetryInterval));
  }

  // 4. Graceful shutdown
  const shutdown = async () => {
    console.error("Shutting down...");
    await closeWhatsApp();
    releaseWhatsAppLock(LOCK_FILE);
    closeDb();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
    shutdown();
  });
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    shutdown();
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
