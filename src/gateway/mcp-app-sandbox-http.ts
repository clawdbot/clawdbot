import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TlsOptions } from "node:tls";
import {
  buildSandboxHostContentSecurityPolicy,
  buildSandboxHostProxyHtml,
  decodeSandboxHostCsp,
  SANDBOX_HOST_PATH,
} from "../agents/sandbox-host.js";
import { respondPlainText } from "./control-ui-http-utils.js";

const MCP_APP_PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), clipboard-write=()";

function handleMcpAppSandboxHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    respondPlainText(res, 400, "Bad Request");
    return;
  }
  if (url.pathname !== SANDBOX_HOST_PATH || (req.method !== "GET" && req.method !== "HEAD")) {
    respondPlainText(res, 404, "Not Found");
    return;
  }

  let csp;
  try {
    csp = decodeSandboxHostCsp(url.searchParams.get("csp"));
  } catch {
    respondPlainText(res, 400, "invalid MCP App sandbox policy");
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", buildSandboxHostContentSecurityPolicy(csp));
  res.setHeader("Permissions-Policy", MCP_APP_PERMISSIONS_POLICY);
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Origin-Agent-Cluster", "?1");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const html = buildSandboxHostProxyHtml(csp);
  // Keep GET and HEAD representation metadata aligned while suppressing the HEAD body.
  res.setHeader("Content-Length", String(Buffer.byteLength(html)));
  res.end(req.method === "HEAD" ? undefined : html);
}

/** Dedicated listener: this origin must never serve Control UI or authenticated Gateway data. */
export function createSandboxHostHttpServer(tlsOptions?: TlsOptions): HttpServer {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    handleMcpAppSandboxHttpRequest(req, res);
  };
  return tlsOptions ? createHttpsServer(tlsOptions, handler) : createHttpServer(handler);
}
