import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TlsOptions } from "node:tls";
import {
  buildMcpAppContentSecurityPolicy,
  buildMcpAppSandboxProxyHtml,
  decodeMcpAppSandboxCsp,
  MCP_APP_SANDBOX_PATH,
} from "../agents/mcp-app-sandbox.js";

const MCP_APP_PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), clipboard-write=()";

function handleMcpAppSandboxHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }
  if (url.pathname !== MCP_APP_SANDBOX_PATH || (req.method !== "GET" && req.method !== "HEAD")) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }

  let csp;
  try {
    csp = decodeMcpAppSandboxCsp(url.searchParams.get("csp"));
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("invalid MCP App sandbox policy");
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", buildMcpAppContentSecurityPolicy(csp));
  res.setHeader("Permissions-Policy", MCP_APP_PERMISSIONS_POLICY);
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Origin-Agent-Cluster", "?1");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(req.method === "HEAD" ? undefined : buildMcpAppSandboxProxyHtml());
}

/** Dedicated listener: this origin must never serve Control UI or authenticated Gateway data. */
export function createMcpAppSandboxHttpServer(tlsOptions?: TlsOptions): HttpServer {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    handleMcpAppSandboxHttpRequest(req, res);
  };
  return tlsOptions ? createHttpsServer(tlsOptions, handler) : createHttpServer(handler);
}
