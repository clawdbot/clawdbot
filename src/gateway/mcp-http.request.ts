import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveMainSessionKey } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { getHeader } from "./http-utils.js";
import { isLoopbackAddress } from "./net.js";
import { checkBrowserOrigin } from "./origin-check.js";

const MAX_MCP_BODY_BYTES = 1_048_576;

function shouldLogMcpLoopbackHttp(): boolean {
  return (
    isTruthyEnvValue(process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT) ||
    isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_DEBUG)
  );
}

function logMcpLoopbackHttp(step: string, details: Record<string, unknown>): void {
  if (!shouldLogMcpLoopbackHttp()) {
    return;
  }
  console.error(`[mcp-loopback] ${step} ${JSON.stringify(details)}`);
}

type McpRequestContext = {
  sessionKey: string;
  messageProvider: string | undefined;
  accountId: string | undefined;
  senderIsOwner: boolean;
};

function resolveScopedSessionKey(cfg: OpenClawConfig, rawSessionKey: string | undefined): string {
  const trimmed = normalizeOptionalString(rawSessionKey);
  return !trimmed || trimmed === "main" ? resolveMainSessionKey(cfg) : trimmed;
}

function rejectsBrowserLoopbackRequest(req: IncomingMessage): boolean {
  const origin = getHeader(req, "origin");
  if (!origin) {
    // No Origin header → not a browser request. Native MCP clients
    // (curl, codex CLI, scripted MCP clients) never set Origin; let
    // them through to the bearer check.
    return false;
  }

  // Defer to checkBrowserOrigin. It already treats loopback peers
  // talking to a loopback Origin as `local-loopback`, which covers
  // the legitimate `localhost`↔`127.0.0.1` mismatch that browsers
  // flag as `Sec-Fetch-Site: cross-site` even though both ends are
  // local. A blanket cross-site early-return here would block that
  // flow even with a valid bearer; the helper's isLocalClient +
  // isLoopbackHost gating is the authoritative check.
  return !checkBrowserOrigin({
    requestHost: getHeader(req, "host"),
    origin,
    isLocalClient: isLoopbackAddress(req.socket?.remoteAddress),
  }).ok;
}

export function validateMcpLoopbackRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  ownerToken: string;
  nonOwnerToken: string;
}): { senderIsOwner: boolean } | null {
  let url: URL;
  try {
    url = new URL(params.req.url ?? "/", `http://${params.req.headers.host ?? "localhost"}`);
  } catch {
    logMcpLoopbackHttp("reject", { reason: "bad_request_url", method: params.req.method ?? "" });
    params.res.writeHead(400, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "bad_request" }));
    return null;
  }

  if (params.req.method === "GET" && url.pathname.startsWith("/.well-known/")) {
    params.res.writeHead(404);
    params.res.end();
    return null;
  }

  if (url.pathname !== "/mcp") {
    logMcpLoopbackHttp("reject", {
      reason: "not_found",
      method: params.req.method ?? "",
      path: url.pathname,
    });
    params.res.writeHead(404, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "not_found" }));
    return null;
  }

  if (params.req.method !== "POST") {
    logMcpLoopbackHttp("reject", {
      reason: "method_not_allowed",
      method: params.req.method ?? "",
      path: url.pathname,
    });
    params.res.writeHead(405, { Allow: "POST" });
    params.res.end();
    return null;
  }

  if (rejectsBrowserLoopbackRequest(params.req)) {
    logMcpLoopbackHttp("reject", {
      reason: "forbidden_origin",
      method: params.req.method ?? "",
      origin: getHeader(params.req, "origin") ?? "",
    });
    params.res.writeHead(403, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "forbidden" }));
    return null;
  }

  const authHeader = getHeader(params.req, "authorization") ?? "";
  const ownerTokenMatched = safeEqualSecret(authHeader, `Bearer ${params.ownerToken}`);
  const nonOwnerTokenMatched = safeEqualSecret(authHeader, `Bearer ${params.nonOwnerToken}`);
  const senderIsOwner = ownerTokenMatched ? true : nonOwnerTokenMatched ? false : null;
  if (senderIsOwner === null) {
    logMcpLoopbackHttp("reject", {
      reason: "unauthorized",
      method: params.req.method ?? "",
      hasAuthorization: authHeader.length > 0,
    });
    params.res.writeHead(401, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "unauthorized" }));
    return null;
  }

  const contentType = getHeader(params.req, "content-type") ?? "";
  if (!contentType.startsWith("application/json")) {
    logMcpLoopbackHttp("reject", {
      reason: "unsupported_media_type",
      method: params.req.method ?? "",
      contentType,
    });
    params.res.writeHead(415, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "unsupported_media_type" }));
    return null;
  }

  return { senderIsOwner };
}

export async function readMcpHttpBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_MCP_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_MCP_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function resolveMcpRequestContext(
  req: IncomingMessage,
  cfg: OpenClawConfig,
  auth: { senderIsOwner: boolean },
): McpRequestContext {
  return {
    sessionKey: resolveScopedSessionKey(cfg, getHeader(req, "x-session-key")),
    messageProvider:
      normalizeMessageChannel(getHeader(req, "x-openclaw-message-channel")) ?? undefined,
    accountId: normalizeOptionalString(getHeader(req, "x-openclaw-account-id")),
    senderIsOwner: auth.senderIsOwner,
  };
}
