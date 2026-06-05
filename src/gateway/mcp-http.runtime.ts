// MCP loopback runtime scope cache.
// Resolves Gateway-visible tools for MCP clients with short-lived schema caching.
import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildMcpToolSchema,
  type McpLoopbackTool,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

// MCP loopback runtime scopes gateway tools to the current session/channel
// context and caches the expensive schema projection for short bursts of tool
// list/call traffic from the same MCP client.
const TOOL_CACHE_TTL_MS = 30_000;
const NATIVE_TOOL_EXCLUDE = new Set(["read", "write", "edit", "apply_patch", "exec", "process"]);

type CachedScopedTools = {
  agentId: string | undefined;
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
  configRef: OpenClawConfig;
  time: number;
};

type McpLoopbackScopeParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  messageProvider: string | undefined;
  currentChannelId: string | undefined;
  currentThreadTs: string | undefined;
  currentMessageId: string | number | undefined;
  currentInboundAudio: boolean | undefined;
  accountId: string | undefined;
  inboundEventKind: InboundEventKind | undefined;
  sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  senderIsOwner: boolean | undefined;
};

/** Resolves loopback-visible tools after applying gateway scope and native-tool exclusions. */
export function resolveMcpLoopbackScopedTools(params: McpLoopbackScopeParams): {
  agentId: string | undefined;
  tools: McpLoopbackTool[];
} {
  const scoped = resolveGatewayScopedTools({
    ...params,
    surface: "loopback",
    excludeToolNames: NATIVE_TOOL_EXCLUDE,
  });
  return {
    agentId: scoped.agentId,
    tools: scoped.tools,
  };
}

/** Short-lived cache for loopback tool lists keyed by session/channel context. */
export class McpLoopbackToolCache {
  #entries = new Map<string, CachedScopedTools>();

  resolve(params: McpLoopbackScopeParams): CachedScopedTools {
    const cacheKey = [
      params.sessionKey,
      params.messageProvider ?? "",
      params.currentChannelId ?? "",
      params.currentThreadTs ?? "",
      params.currentMessageId != null ? String(params.currentMessageId) : "",
      params.currentInboundAudio === true ? "audio" : "no-audio",
      params.accountId ?? "",
      params.inboundEventKind ?? "",
      params.sourceReplyDeliveryMode ?? "",
      params.senderIsOwner === true ? "owner" : "non-owner",
    ].join("\u0000");
    const now = Date.now();
    const cached = this.#entries.get(cacheKey);
    // Config object identity is part of the cache contract so explicit gateway
    // reloads invalidate tool scope and schema without filesystem polling.
    if (cached && cached.configRef === params.cfg && now - cached.time < TOOL_CACHE_TTL_MS) {
      return cached;
    }

    const next = resolveMcpLoopbackScopedTools(params);
    const nextEntry: CachedScopedTools = {
      agentId: next.agentId,
      tools: next.tools,
      toolSchema: buildMcpToolSchema(next.tools),
      configRef: params.cfg,
      time: now,
    };
    this.#entries.set(cacheKey, nextEntry);
    for (const [key, entry] of this.#entries) {
      if (now - entry.time >= TOOL_CACHE_TTL_MS) {
        this.#entries.delete(key);
      }
    }
    return nextEntry;
  }
}
