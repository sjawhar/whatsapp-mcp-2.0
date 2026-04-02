import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

type Cleanup = () => void;

export async function startConnectProxy(url: string, apiKey: string): Promise<void> {
  const localTransport = new StdioServerTransport();
  const remoteTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  });

  let shuttingDown = false;
  let parentWatchdog: NodeJS.Timeout | undefined;
  const cleanups: Cleanup[] = [];

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    if (parentWatchdog) {
      clearInterval(parentWatchdog);
      parentWatchdog = undefined;
    }

    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      cleanup?.();
    }

    await Promise.allSettled([remoteTransport.close(), localTransport.close()]);
  };

  const bridgeToRemote = async (message: JSONRPCMessage): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    try {
      await remoteTransport.send(message);
    } catch (error) {
      console.error("Failed forwarding stdio → HTTP MCP message:", error);
      await shutdown();
    }
  };

  const bridgeToLocal = async (message: JSONRPCMessage): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    try {
      await localTransport.send(message);
    } catch (error) {
      console.error("Failed forwarding HTTP → stdio MCP message:", error);
      await shutdown();
    }
  };

  localTransport.onmessage = (message) => {
    void bridgeToRemote(message);
  };
  localTransport.onerror = (error) => {
    console.error("Local stdio transport error:", error);
    void shutdown();
  };
  localTransport.onclose = () => {
    void shutdown();
  };

  remoteTransport.onmessage = (message) => {
    void bridgeToLocal(message);
  };
  remoteTransport.onerror = (error) => {
    console.error("Remote HTTP transport error:", error);
    void shutdown();
  };
  remoteTransport.onclose = () => {
    void shutdown();
  };

  const stdinEndHandler = () => {
    console.error("stdin closed (parent disconnected) — shutting down");
    void shutdown();
  };
  process.stdin.on("end", stdinEndHandler);
  cleanups.push(() => process.stdin.off("end", stdinEndHandler));

  const sigintHandler = () => {
    void shutdown();
  };
  const sigtermHandler = () => {
    void shutdown();
  };
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);
  cleanups.push(() => process.off("SIGINT", sigintHandler));
  cleanups.push(() => process.off("SIGTERM", sigtermHandler));

  const originalPpid = process.ppid;
  const getLivePpid = (): number => {
    try {
      const stat = fs.readFileSync("/proc/self/stat", "utf8");
      return parseInt(stat.split(" ")[3], 10);
    } catch {
      return process.ppid;
    }
  };
  parentWatchdog = setInterval(() => {
    const currentPpid = getLivePpid();
    if (currentPpid !== originalPpid) {
      console.error(`Parent changed (${originalPpid} → ${currentPpid}) — shutting down`);
      void shutdown();
    }
  }, 5_000);

  await remoteTransport.start();
  await localTransport.start();
  console.error(`MCP stdio proxy connected to ${url}`);

  await new Promise<void>((resolve) => {
    const checkShutdown = (): void => {
      if (shuttingDown) {
        resolve();
        return;
      }

      setTimeout(checkShutdown, 100);
    };

    checkShutdown();
  });
}
