import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";

import type { AppConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(req: Request): string | undefined {
  const header = req.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

function bearerAuth(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = bearerToken(req);
    if (config.authMode === "maimemo-token") {
      if (!token) {
        res.setHeader("WWW-Authenticate", "Bearer");
        res.status(401).json({ error: "maimemo_token_required" });
        return;
      }
      (res.locals as { maimemoApiToken?: string }).maimemoApiToken = token;
      next();
      return;
    }

    if (!config.mcpBearerToken) {
      next();
      return;
    }
    if (!token || !secureEqual(token, config.mcpBearerToken)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function createApp(config: AppConfig) {
  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts });
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      service: "momo-mcp",
      tokenConfigured: Boolean(config.maimemoApiToken),
      authenticationMode: config.authMode,
      mutationsEnabled: config.allowMutations
    });
  });

  app.post(config.mcpPath, bearerAuth(config), async (req, res) => {
    const requestToken = (res.locals as { maimemoApiToken?: string }).maimemoApiToken;
    const requestConfig: AppConfig = requestToken
      ? { ...config, maimemoApiToken: requestToken }
      : config;
    const server = createMcpServer(requestConfig);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null
    });
  };
  app.get(config.mcpPath, (req, res, next) => {
    // Browser visits use the shared center; MCP SSE GET remains unsupported.
    if (!req.accepts("html")) return next();
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Accept");
    res.redirect(302, "/center/");
  }, bearerAuth(config), methodNotAllowed);
  app.delete(config.mcpPath, bearerAuth(config), methodNotAllowed);

  return app;
}

export function listen(config: AppConfig): Server {
  const app = createApp(config);
  return app.listen(config.port, config.host, () => {
    console.log(`momo-mcp listening on http://${config.host}:${config.port}${config.mcpPath}`);
  });
}
