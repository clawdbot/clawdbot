// MCP loopback HTTP request helpers.
// Authenticates local MCP POST requests and extracts scoped Gateway context.
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import { getHeader } from "./http-utils.js";
import {
  resolveAttachGrant,
  resolveMcpLoopbackClientGrant,
  type McpLoopbackRequestContext,
} from "./mcp-grant-store.js";
import { isLoopbackAddress } from "./net.js";
import { checkBrowserOrigin } from "./origin-check.js";

const MAX_MCP_BODY_BYTES = 1_048_576;
const DEFAULT_MCP_BODY_TIMEOUT_MS = 30_000;
const MCP_HTTP_BODY_TOO_LARGE_CODE = "ETOOBIG";
const MCP_HTTP_BODY_TIMEOUT_CODE = "ETIMEDOUT";
const MCP_HTTP_BODY_CLOSED_CODE = "ECONNRESET";

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${name} must be a positive integer. Got: ${JSON.stringify(raw)}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer. Got: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

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

type McpRequestContext = McpLoopbackRequestContext;

type McpLoopbackRequestAuth = {
  senderIsOwner: boolean;
  boundSessionKey?: string;
  boundContext?: McpLoopbackRequestContext;
  boundCaptureKey?: string;
  boundGrantToken?: string;
};

function resolveScopedSessionKey(cfg: OpenClawConfig, rawSessionKey: string | undefined): string {
  const trimmed = normalizeOptionalString(rawSessionKey);
  return !trimmed || trimmed === "main" ? resolveMainSessionKey(cfg) : trimmed;
}

function normalizeMcpInboundEventKind(value: string | undefined): InboundEventKind | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed === "room_event" || trimmed === "user_request" ? trimmed : undefined;
}

function normalizeMcpSourceReplyDeliveryMode(
  value: string | undefined,
): SourceReplyDeliveryMode | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed === "automatic" || trimmed === "message_tool_only" ? trimmed : undefined;
}

function normalizeMcpTaskSuggestionDeliveryMode(
  value: string | undefined,
): TaskSuggestionDeliveryMode | undefined {
  return normalizeOptionalString(value) === "gateway" ? "gateway" : undefined;
}

function normalizeMcpBooleanHeader(value: string | undefined): boolean | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? isTruthyEnvValue(trimmed) : undefined;
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

function resolveMcpSender(params: {
  req: IncomingMessage;
  ownerToken: string;
  nonOwnerToken: string;
}): McpLoopbackRequestAuth | undefined {
  const authHeader = getHeader(params.req, "authorization") ?? "";
  const ownerTokenMatched = safeEqualSecret(authHeader, `Bearer ${params.ownerToken}`);
  const nonOwnerTokenMatched = safeEqualSecret(authHeader, `Bearer ${params.nonOwnerToken}`);
  if (ownerTokenMatched || nonOwnerTokenMatched) {
    return { senderIsOwner: ownerTokenMatched };
  }
  const grantToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  const captureKey = normalizeOptionalString(getHeader(params.req, "x-openclaw-cli-capture-key"));
  const clientGrant =
    grantToken && captureKey
      ? resolveMcpLoopbackClientGrant({
          token: grantToken,
          runtimeOwnerToken: params.ownerToken,
          captureKey,
        })
      : undefined;
  if (clientGrant) {
    return {
      senderIsOwner: clientGrant.context.senderIsOwner,
      boundContext: clientGrant.context,
      boundCaptureKey: clientGrant.captureKey,
      boundGrantToken: grantToken,
    };
  }
  const grant = grantToken ? resolveAttachGrant(grantToken) : undefined;
  if (grant) {
    return { senderIsOwner: false, boundSessionKey: grant.sessionKey };
  }
  return undefined;
}

export function validateMcpLoopbackRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  ownerToken: string;
  nonOwnerToken: string;
  onSseResponse?: (res: ServerResponse) => void;
}): McpLoopbackRequestAuth | null {
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

  if (params.req.method === "GET" || params.req.method === "DELETE") {
    // Origin validation first (matches the POST path): a browser loopback request is
    // rejected before bearer auth, so the local-loopback Origin boundary holds even for
    // unauthenticated browser requests.
    if (rejectsBrowserLoopbackRequest(params.req)) {
      params.res.writeHead(403, { "Content-Type": "application/json" });
      params.res.end(JSON.stringify({ error: "forbidden" }));
      return null;
    }
    const sender = resolveMcpSender(params);
    if (!sender) {
      params.res.writeHead(401, { "Content-Type": "application/json" });
      params.res.end(JSON.stringify({ error: "unauthorized" }));
      return null;
    }
    if (params.req.method === "GET") {
      logMcpLoopbackHttp("sse-open", { method: "GET", path: url.pathname });
      params.res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      params.res.flushHeaders();
      params.res.write(":\n\n");
      params.onSseResponse?.(params.res);
      params.req.on("close", () => {
        if (!params.res.writableEnded) {
          params.res.end();
        }
      });
      return null;
    }

    // Streamable HTTP session teardown. The loopback server is stateless — it owns no
    // session lifecycle — so this is an auth-gated no-op acknowledgement: clients that
    // send DELETE when closing the transport get a clean 200 rather than a 405.
    logMcpLoopbackHttp("session-delete", { method: "DELETE", path: url.pathname });
    params.res.writeHead(200, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ ok: true }));
    return null;
  }

  if (params.req.method !== "POST") {
    logMcpLoopbackHttp("reject", {
      reason: "method_not_allowed",
      method: params.req.method ?? "",
      path: url.pathname,
    });
    params.res.writeHead(405, { Allow: "GET, POST, DELETE" });
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

  const sender = resolveMcpSender(params);
  if (!sender) {
    logMcpLoopbackHttp("reject", {
      reason: "unauthorized",
      method: params.req.method ?? "",
      hasAuthorization: (getHeader(params.req, "authorization") ?? "").length > 0,
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

  return {
    senderIsOwner: sender.senderIsOwner,
    boundSessionKey: sender.boundSessionKey,
    boundContext: sender.boundContext,
    boundCaptureKey: sender.boundCaptureKey,
    boundGrantToken: sender.boundGrantToken,
  };
}

export async function readMcpHttpBody(
  req: IncomingMessage,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? MAX_MCP_BODY_BYTES));
    const timeoutMs = resolveSafeTimeoutDelayMs(options.timeoutMs ?? DEFAULT_MCP_BODY_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    // Remove listeners on every terminal path; oversized bodies keep the error
    // listener briefly so Node can deliver the pause/error safely.
    const cleanup = (cleanupOptions?: { keepErrorListener?: boolean }) => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("close", onClose);
      if (cleanupOptions?.keepErrorListener !== true) {
        req.off("error", onError);
      }
      clearTimeout(timeout);
    };
    const rejectOnce = (error: Error, rejectOptions?: { keepErrorListener?: boolean }) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(rejectOptions);
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.pause();
        rejectOnce(createMcpHttpBodyTooLargeError(maxBytes), { keepErrorListener: true });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf-8"));
    };
    const onError = (error: Error) => {
      rejectOnce(error);
    };
    const onClose = () => {
      rejectOnce(createMcpHttpBodyClosedError());
    };
    const timeout = setTimeout(() => {
      req.pause();
      rejectOnce(createMcpHttpBodyTimeoutError(), { keepErrorListener: true });
    }, timeoutMs);
    timeout.unref?.();

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("close", onClose);
    req.on("error", onError);
  });
}

function createMcpHttpBodyTooLargeError(maxBytes: number): Error & { code: string } {
  return Object.assign(new Error(`Request body exceeds ${maxBytes} bytes`), {
    code: MCP_HTTP_BODY_TOO_LARGE_CODE,
  });
}

function createMcpHttpBodyTimeoutError(): Error & { code: string } {
  return Object.assign(new Error("Request body timed out"), {
    code: MCP_HTTP_BODY_TIMEOUT_CODE,
  });
}

function createMcpHttpBodyClosedError(): Error & { code: string } {
  return Object.assign(new Error("Request body connection closed"), {
    code: MCP_HTTP_BODY_CLOSED_CODE,
  });
}

export function isMcpHttpBodyTooLargeError(error: unknown): error is Error & { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === MCP_HTTP_BODY_TOO_LARGE_CODE
  );
}

export function isMcpHttpBodyTimeoutError(error: unknown): error is Error & { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === MCP_HTTP_BODY_TIMEOUT_CODE
  );
}

export function resolveMcpHttpBodyTimeoutMs(): number {
  return readPositiveIntEnv("OPENCLAW_MCP_LOOPBACK_BODY_TIMEOUT_MS", DEFAULT_MCP_BODY_TIMEOUT_MS);
}

export function resolveMcpCliCaptureKey(
  req: IncomingMessage,
  auth: McpLoopbackRequestAuth,
): string | undefined {
  if (auth.boundContext || auth.boundSessionKey) {
    return auth.boundCaptureKey;
  }
  return normalizeOptionalString(getHeader(req, "x-openclaw-cli-capture-key"));
}

function normalizeMcpClientCapsHeader(value: string | undefined): string[] | undefined {
  const clientCaps = [...new Set((value ?? "").split(",").map((cap) => cap.trim()))].filter(
    Boolean,
  );
  return clientCaps.length > 0 ? clientCaps : undefined;
}

export function resolveMcpRequestContext(
  req: IncomingMessage,
  cfg: OpenClawConfig,
  auth: McpLoopbackRequestAuth,
): McpRequestContext {
  if (auth.boundContext) {
    // Gateway-launched CLI clients receive an immutable context grant. The
    // child process can replay the token, but cannot scope-shop by rewriting
    // session, channel, capability, or ownership headers.
    return structuredClone(auth.boundContext);
  }
  // Grant-authenticated callers get only their server-bound session; spoofable
  // delivery/action headers stay reserved for the gateway-launched loopback client.
  if (auth.boundSessionKey) {
    return {
      sessionKey: auth.boundSessionKey,
      sessionId: undefined,
      messageProvider: undefined,
      clientCaps: undefined,
      currentChannelId: undefined,
      currentThreadTs: undefined,
      currentMessageId: undefined,
      currentInboundAudio: undefined,
      accountId: undefined,
      inboundEventKind: undefined,
      sourceReplyDeliveryMode: undefined,
      taskSuggestionDeliveryMode: undefined,
      requireExplicitMessageTarget: undefined,
      senderIsOwner: auth.senderIsOwner,
    };
  }
  return {
    sessionKey: resolveScopedSessionKey(cfg, getHeader(req, "x-session-key")),
    sessionId: normalizeOptionalString(getHeader(req, "x-openclaw-session-id")),
    messageProvider:
      normalizeMessageChannel(getHeader(req, "x-openclaw-message-channel")) ?? undefined,
    // The token-authenticated loopback client is gateway-spawned on 127.0.0.1. Caps only
    // widen tool availability; sender ownership remains derived from the bearer token.
    clientCaps: normalizeMcpClientCapsHeader(getHeader(req, "x-openclaw-client-caps")),
    currentChannelId: normalizeOptionalString(getHeader(req, "x-openclaw-current-channel-id")),
    currentThreadTs: normalizeOptionalString(getHeader(req, "x-openclaw-current-thread-ts")),
    currentMessageId: normalizeOptionalString(getHeader(req, "x-openclaw-current-message-id")),
    currentInboundAudio: normalizeMcpBooleanHeader(
      getHeader(req, "x-openclaw-current-inbound-audio"),
    ),
    accountId: normalizeOptionalString(getHeader(req, "x-openclaw-account-id")),
    inboundEventKind: normalizeMcpInboundEventKind(getHeader(req, "x-openclaw-inbound-event-kind")),
    sourceReplyDeliveryMode: normalizeMcpSourceReplyDeliveryMode(
      getHeader(req, "x-openclaw-source-reply-delivery-mode"),
    ),
    taskSuggestionDeliveryMode: normalizeMcpTaskSuggestionDeliveryMode(
      getHeader(req, "x-openclaw-task-suggestion-delivery-mode"),
    ),
    requireExplicitMessageTarget: normalizeMcpBooleanHeader(
      getHeader(req, "x-openclaw-require-explicit-message-target"),
    ),
    senderIsOwner: auth.senderIsOwner,
  };
}
