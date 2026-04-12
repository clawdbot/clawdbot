import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveMainSessionKey } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { getHeader } from "./http-utils.js";

const MAX_MCP_BODY_BYTES = 1_048_576;

export type McpRequestContext = {
  sessionKey: string;
  messageProvider: string | undefined;
  accountId: string | undefined;
  senderIsOwner: boolean | undefined;
};

function resolveScopedSessionKey(cfg: OpenClawConfig, rawSessionKey: string | undefined): string {
  const trimmed = normalizeOptionalString(rawSessionKey);
  return !trimmed || trimmed === "main" ? resolveMainSessionKey(cfg) : trimmed;
}

export function validateMcpLoopbackRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  token: string;
}): boolean {
  let url: URL;
  try {
    url = new URL(params.req.url ?? "/", `http://${params.req.headers.host ?? "localhost"}`);
  } catch {
    params.res.writeHead(400, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "bad_request" }));
    return false;
  }

  if (params.req.method === "GET" && url.pathname.startsWith("/.well-known/")) {
    params.res.writeHead(404);
    params.res.end();
    return false;
  }

  if (url.pathname !== "/mcp") {
    params.res.writeHead(404, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "not_found" }));
    return false;
  }

  if (params.req.method !== "POST") {
    params.res.writeHead(405, { Allow: "POST" });
    params.res.end();
    return false;
  }

  const authHeader = getHeader(params.req, "authorization") ?? "";
  if (authHeader !== `Bearer ${params.token}`) {
    params.res.writeHead(401, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "unauthorized" }));
    return false;
  }

  const contentType = getHeader(params.req, "content-type") ?? "";
  if (!contentType.startsWith("application/json")) {
    params.res.writeHead(415, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "unsupported_media_type" }));
    return false;
  }

  return true;
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
): McpRequestContext {
  const senderIsOwnerRaw = normalizeOptionalLowercaseString(
    getHeader(req, "x-openclaw-sender-is-owner"),
  );
  return {
    sessionKey: resolveScopedSessionKey(cfg, getHeader(req, "x-session-key")),
    messageProvider:
      normalizeMessageChannel(getHeader(req, "x-openclaw-message-channel")) ?? undefined,
    accountId: normalizeOptionalString(getHeader(req, "x-openclaw-account-id")),
    senderIsOwner:
      senderIsOwnerRaw === "true" ? true : senderIsOwnerRaw === "false" ? false : undefined,
  };
}
