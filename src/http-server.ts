import { randomUUID } from "node:crypto";
import { createServer, type Server as NodeHttpServer } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./tools.js";

type SessionState = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

type SessionMap = Map<string, SessionState>;

export type HttpServerController = {
  port: number;
  host: string;
  closeHttpServer: () => Promise<void>;
};

function parseBearerToken(authorization: string | string[] | undefined): string | undefined {
  if (typeof authorization !== "string") {
    return undefined;
  }

  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    return undefined;
  }

  return token;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function createHostValidationMiddleware(host: string) {
  if (!isLoopbackHost(host)) {
    return (_req: Request, _res: Response, next: NextFunction): void => {
      next();
    };
  }

  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

  return (req: Request, res: Response, next: NextFunction): void => {
    const hostHeader = req.headers.host;
    if (!hostHeader) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Missing Host header" },
        id: null,
      });
      return;
    }

    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: `Invalid Host header: ${hostHeader}` },
        id: null,
      });
      return;
    }

    if (!allowedHosts.has(hostname)) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: `Invalid Host: ${hostname}` },
        id: null,
      });
      return;
    }

    next();
  };
}

function createBearerAuthMiddleware(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = parseBearerToken(req.headers.authorization);
    if (token !== apiKey) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  };
}

function wirePostRoute(app: express.Express, sessions: SessionMap): void {
  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.header("mcp-session-id");
      const existing = sessionId ? sessions.get(sessionId) : undefined;

      if (existing) {
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const server = new McpServer({ name: "whatsapp", version: "1.0.0" });
        registerTools(server);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server });
          },
        });

        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) {
            sessions.delete(id);
          }
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
    } catch (error) {
      console.error("Error handling MCP POST:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });
}

function wireGetAndDeleteRoutes(app: express.Express, sessions: SessionMap): void {
  const handler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header("mcp-session-id");
    if (!sessionId) {
      res.status(400).send("Missing Mcp-Session-Id header");
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).send("Unknown session");
      return;
    }

    await session.transport.handleRequest(req, res);
  };

  app.get("/mcp", handler);
  app.delete("/mcp", handler);
}

export async function createHttpServer(port: number, host: string, apiKey: string): Promise<HttpServerController> {
  const sessions: SessionMap = new Map();
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(createHostValidationMiddleware(host));
  app.use(createBearerAuthMiddleware(apiKey));

  wirePostRoute(app, sessions);
  wireGetAndDeleteRoutes(app, sessions);

  const httpServer = createServer(app);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve HTTP listening address");
  }

  const closeHttpServer = async (): Promise<void> => {
    await closeSessions(sessions);
    await closeNodeServer(httpServer);
  };

  return {
    port: address.port,
    host,
    closeHttpServer,
  };
}

async function closeSessions(sessions: SessionMap): Promise<void> {
  const states = [...sessions.values()];
  sessions.clear();

  for (const { transport, server } of states) {
    await transport.close();
    await server.close();
  }
}

async function closeNodeServer(server: NodeHttpServer): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
