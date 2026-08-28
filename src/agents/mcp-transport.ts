/**
 * MCP client transport factory.
 *
 * This module turns normalized MCP server config into stdio, SSE, or
 * streamable-HTTP SDK transports with OpenClaw auth, redirect, and logging rules.
 */
import { StringDecoder } from "node:string_decoder";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logDebug } from "../logger.js";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";
import type { SessionMcpRequesterScope } from "./agent-bundle-mcp-types.js";
import { resolveMcpAuthProfileId, withMcpAuthProfileBearer } from "./mcp-auth-profile.js";
import {
  buildMcpHttpFetch,
  withoutMcpAuthorizationHeader,
  withSameOriginMcpHttpHeaders,
} from "./mcp-http-fetch.js";
import {
  OpenClawSSEClientTransport,
  OpenClawStreamableHTTPClientTransport,
} from "./mcp-http-transport.js";
import { withMcpOAuthBearer } from "./mcp-oauth-fetch.js";
import { operatorMcpOAuthIdentity, requesterMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

type ResolvedMcpTransport = {
  transport: Transport;
  description: string;
  transportType: "stdio" | "sse" | "streamable-http";
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  supportsParallelToolCalls: boolean;
  detachStderr?: () => void;
};

const MAX_MCP_STDERR_LINE_BYTES = 8 * 1024;

function attachStderrLogging(serverName: string, transport: OpenClawStdioClientTransport) {
  const stderr = transport.stderr;
  if (!stderr) {
    return undefined;
  }
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let truncated = false;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const emit = (text: string) => {
    const tail = truncateUtf8Suffix(text, MAX_MCP_STDERR_LINE_BYTES);
    const message = `${truncated || tail !== text ? "[stderr line truncated] " : ""}${tail}`.trim();
    truncated = false;
    if (message) {
      logDebug(`bundle-mcp:${serverName}: ${message}`);
    }
  };
  const flushProgress = () => {
    progressTimer = undefined;
    const text = pending;
    pending = "";
    emit(text);
  };
  const onData = (chunk: Buffer | string) => {
    const decoded = decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const lines = (pending + decoded).split(/[\r\n]/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      emit(line);
    }
    const tail = truncateUtf8Suffix(pending, MAX_MCP_STDERR_LINE_BYTES);
    truncated ||= tail !== pending;
    pending = tail;
    // No-newline progress must stay visible even under continuous writes. Flush
    // complete characters within 250ms; only finalization ends the UTF-8 decoder.
    if (pending && !progressTimer) {
      progressTimer = setTimeout(flushProgress, 250);
      progressTimer.unref();
    } else if (!pending) {
      clearTimeout(progressTimer);
      progressTimer = undefined;
    }
  };
  const finalize = () => {
    stderr.off("data", onData);
    stderr.off("end", finalize);
    stderr.off("close", finalize);
    clearTimeout(progressTimer);
    pending += decoder.end();
    flushProgress();
  };
  stderr.on("data", onData);
  stderr.on("end", finalize);
  stderr.on("close", finalize);
  return finalize;
}

type SseEventSourceFetch = NonNullable<
  NonNullable<SSEClientTransportOptions["eventSourceInit"]>["fetch"]
>;

function buildSseEventSourceFetch(
  headers: Record<string, string>,
  baseFetch: FetchLike,
): SseEventSourceFetch {
  return (url: string | URL, init?: RequestInit) => {
    // Header names are case-insensitive, but object spreads preserve case
    // variants and can duplicate Authorization on the wire. Normalize before
    // merging so operator headers override SDK headers as a single entry.
    const mergedHeaders: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers)) {
      mergedHeaders[key.toLowerCase()] = value;
    }
    for (const [key, value] of Object.entries(headers)) {
      mergedHeaders[key.toLowerCase()] = value;
    }
    return baseFetch(url, {
      ...(init as RequestInit),
      headers: mergedHeaders,
    }) as ReturnType<SseEventSourceFetch>;
  };
}

/** Resolves a configured MCP server into a live SDK transport instance. */
export function resolveMcpTransport(
  serverName: string,
  rawServer: unknown,
  options?: {
    cfg?: OpenClawConfig;
    agentDir?: string;
    prepareDataDir?: string;
    requesterScope?: SessionMcpRequesterScope;
  },
): ResolvedMcpTransport | null {
  const resolved = resolveMcpTransportConfig(serverName, rawServer);
  if (!resolved) {
    return null;
  }
  if (resolved.kind === "stdio") {
    const transport = new OpenClawStdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
      cwd: resolved.cwd,
      prepareDataDir: options?.prepareDataDir,
      stderr: "pipe",
    });
    return {
      transport,
      description: resolved.description,
      transportType: "stdio",
      connectionTimeoutMs: resolved.connectionTimeoutMs,
      requestTimeoutMs: resolved.requestTimeoutMs,
      supportsParallelToolCalls: resolved.supportsParallelToolCalls,
      detachStderr: attachStderrLogging(serverName, transport),
    };
  }
  const authProfileId = resolveMcpAuthProfileId(rawServer);
  const requesterScope = options?.requesterScope;
  let oauthIdentity;
  if (resolved.oauth?.identity === "per-requester") {
    if (!requesterScope) {
      return null;
    }
    oauthIdentity = requesterMcpOAuthIdentity(serverName, resolved.url, requesterScope);
  } else {
    oauthIdentity = operatorMcpOAuthIdentity(serverName, resolved.url);
  }
  // The SDK reuses one fetch for OAuth and long-lived SSE/streamable bodies.
  // Per-RPC deadlines belong to client calls, not this transport fetch.
  const baseFetch = buildMcpHttpFetch({
    sslVerify: resolved.sslVerify,
    clientCert: resolved.clientCert,
    clientKey: resolved.clientKey,
    resourceUrl: resolved.url,
  });
  const headers =
    resolved.auth === "oauth" || authProfileId
      ? withoutMcpAuthorizationHeader(resolved.headers)
      : resolved.headers;
  const resourceFetch = withSameOriginMcpHttpHeaders({
    fetchFn: baseFetch,
    headers,
    resourceUrl: resolved.url,
  });
  const httpFetch = authProfileId
    ? withMcpAuthProfileBearer({
        fetchFn: baseFetch,
        serverName,
        resourceUrl: resolved.url,
        headers,
        authProfileId,
        cfg: options?.cfg,
        agentDir: options?.agentDir,
      })
    : resolved.auth === "oauth"
      ? withMcpOAuthBearer({
          fetchFn: resourceFetch,
          // Protected-resource discovery lives at the resource origin and may
          // require the same routing headers. Cross-origin auth calls stay scrubbed.
          authFetchFn: resourceFetch,
          identity: oauthIdentity,
          config: resolved.oauth,
        })
      : baseFetch;
  if (resolved.transportType === "streamable-http") {
    return {
      transport: new OpenClawStreamableHTTPClientTransport(new URL(resolved.url), {
        requestInit: resolved.auth === "oauth" || !headers ? undefined : { headers },
        fetch: httpFetch,
      }),
      description: resolved.description,
      transportType: "streamable-http",
      connectionTimeoutMs: resolved.connectionTimeoutMs,
      requestTimeoutMs: resolved.requestTimeoutMs,
      supportsParallelToolCalls: resolved.supportsParallelToolCalls,
    };
  }
  const sseHeaders: Record<string, string> = { ...headers };
  const hasHeaders = Object.keys(sseHeaders).length > 0;
  return {
    transport: new OpenClawSSEClientTransport(new URL(resolved.url), {
      requestInit: resolved.auth === "oauth" || !hasHeaders ? undefined : { headers: sseHeaders },
      fetch: httpFetch,
      eventSourceInit: {
        fetch: buildSseEventSourceFetch(resolved.auth === "oauth" ? {} : sseHeaders, httpFetch),
      },
    }),
    description: resolved.description,
    transportType: "sse",
    connectionTimeoutMs: resolved.connectionTimeoutMs,
    requestTimeoutMs: resolved.requestTimeoutMs,
    supportsParallelToolCalls: resolved.supportsParallelToolCalls,
  };
}
