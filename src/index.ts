#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs";
import { initDb, closeDb } from "./db.js";
import {
  initWhatsApp,
  closeWhatsApp,
  resolveConnectionAsReadOnly,
  setMessageNotificationHandler,
} from "./whatsapp.js";
import { registerTools } from "./tools.js";
import { acquireWhatsAppLock, releaseWhatsAppLock } from "./lock.js";
import { LOCK_FILE, DATA_DIR } from "./paths.js";
import { createHttpServer, type HttpServerController } from "./http-server.js";
import {
  NEW_MESSAGES_RESOURCE_URI,
  createResourceSubscriptionStore,
  registerResourceSubscriptionHandlers,
  registerResources,
} from "./resources.js";
console.error(`Data directory: ${DATA_DIR}`);

type CliOptions = {
  http: boolean;
  port: number;
  host: string;
};

function parseCliOptions(argv: string[]): CliOptions {
  let http = false;
  let port = 3456;
  let host = "0.0.0.0";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--http") {
      http = true;
      continue;
    }

    if (arg === "--port") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--port requires a value");
      }
      const parsedPort = Number.parseInt(value, 10);
      if (Number.isNaN(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
        throw new Error(`Invalid --port value: ${value}`);
      }
      port = parsedPort;
      i += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      const value = arg.slice("--port=".length);
      const parsedPort = Number.parseInt(value, 10);
      if (Number.isNaN(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
        throw new Error(`Invalid --port value: ${value}`);
      }
      port = parsedPort;
      continue;
    }

    if (arg === "--host") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--host requires a value");
      }
      host = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    }
  }

  return { http, port, host };
}

async function main() {
  console.error("Starting WhatsApp MCP Server...");
  const options = parseCliOptions(process.argv.slice(2));
  let stdioServer: McpServer | undefined;
  let httpController: HttpServerController | undefined;
  let stdioSessionId: string | undefined;
  let parentWatchdog: NodeJS.Timeout | undefined;
  let lockRetryInterval: NodeJS.Timeout | undefined;
  let ownsWhatsAppLock = false;
  let shuttingDown = false;
  const resourceSubscriptions = createResourceSubscriptionStore();
  let debouncedNotificationTimer: NodeJS.Timeout | undefined;

  setMessageNotificationHandler(() => {
    if (debouncedNotificationTimer) {
      clearTimeout(debouncedNotificationTimer);
    }

    debouncedNotificationTimer = setTimeout(() => {
      debouncedNotificationTimer = undefined;
      void resourceSubscriptions.notifyResourceUpdated(NEW_MESSAGES_RESOURCE_URI);
    }, 500);
  });

  // 1. Initialize SQLite database (synchronous, instant).
  initDb();

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    console.error("Shutting down...");
    if (parentWatchdog) {
      clearInterval(parentWatchdog);
      parentWatchdog = undefined;
    }
    if (lockRetryInterval) {
      clearInterval(lockRetryInterval);
      lockRetryInterval = undefined;
    }
    if (debouncedNotificationTimer) {
      clearTimeout(debouncedNotificationTimer);
      debouncedNotificationTimer = undefined;
    }
    setMessageNotificationHandler(undefined);

    await closeWhatsApp();
    if (ownsWhatsAppLock) {
      releaseWhatsAppLock(LOCK_FILE);
    }
    closeDb();

    if (httpController) {
      await httpController.closeHttpServer();
    }
    if (stdioServer) {
      if (stdioSessionId) {
        resourceSubscriptions.removeSession(stdioSessionId);
        stdioSessionId = undefined;
      }
      await stdioServer.close();
    }

    process.exit(0);
  };

  if (options.http) {
    const apiKey = process.env.MCP_API_KEY;
    if (!apiKey) {
      throw new Error("MCP_API_KEY is required when using --http mode");
    }

    httpController = await createHttpServer(options.port, options.host, apiKey, resourceSubscriptions);
    console.error(`MCP server running on HTTP ${options.host}:${httpController.port}`);

    initWhatsApp().catch((err) => {
      console.error("Failed to initialize WhatsApp:", err);
    });
  } else {
    // 2. Create MCP server and connect to stdio transport FIRST
    //    so the client doesn't time out waiting for the initialize handshake.
    stdioServer = new McpServer(
      {
        name: "whatsapp",
        version: "1.0.0",
      },
      {
        capabilities: {
          resources: {
            subscribe: true,
            listChanged: true,
          },
        },
      }
    );
    const activeStdioServer = stdioServer;

    registerTools(activeStdioServer);
    registerResources(activeStdioServer);
    stdioSessionId = `stdio-${randomUUID()}`;
    resourceSubscriptions.registerSession(stdioSessionId, (uri) => activeStdioServer.server.sendResourceUpdated({ uri }));
    registerResourceSubscriptionHandlers(activeStdioServer, stdioSessionId, resourceSubscriptions);

    const transport = new StdioServerTransport();
    await activeStdioServer.connect(transport);
    console.error("MCP server running on stdio");

    // Detect parent death via two mechanisms:
    // 1. stdin EOF — works when process is spawned directly (not via npm wrapper chain)
    process.stdin.on("end", () => {
      console.error("stdin closed (parent disconnected) — shutting down");
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
        const stat = fs.readFileSync("/proc/self/stat", "utf8");
        return parseInt(stat.split(" ")[3], 10);
      } catch {
        return process.ppid; // Fallback for non-Linux
      }
    };
    parentWatchdog = setInterval(() => {
      const currentPpid = getLivePpid();
      if (currentPpid !== originalPpid) {
        console.error(`Parent changed (${originalPpid} → ${currentPpid}) — shutting down`);
        shutdown();
      }
    }, 5_000);

    // 3. Initialize WhatsApp in the background — but only if no other instance
    //    already owns the WhatsApp connection. This prevents status 515/440
    //    when the host spawns multiple MCP server instances.
    if (acquireWhatsAppLock(LOCK_FILE)) {
      ownsWhatsAppLock = true;
      console.error("WhatsApp lock acquired — connecting...");
      initWhatsApp().catch((err) => {
        console.error("Failed to initialize WhatsApp:", err);
      });
    } else {
      console.error("Another instance owns the WhatsApp connection — running as read-only from SQLite");
      resolveConnectionAsReadOnly();

      // Periodically check if the lock holder died — if so, take over
      lockRetryInterval = setInterval(() => {
        if (acquireWhatsAppLock(LOCK_FILE)) {
          ownsWhatsAppLock = true;
          console.error("Lock holder died — upgrading to read-write mode");
          if (lockRetryInterval) {
            clearInterval(lockRetryInterval);
            lockRetryInterval = undefined;
          }

          initWhatsApp().catch((err) => {
            console.error("Failed to initialize WhatsApp after lock takeover:", err);
          });
        }
      }, 10_000); // Check every 10 seconds
    }
  }

  // 4. Graceful shutdown
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
