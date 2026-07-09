// MCP loopback runtime scope cache.
// Resolves Gateway-visible tools for MCP clients with short-lived schema caching.
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
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
const TOOL_CACHE_MAX_ENTRIES = 256;
// Tools excluded from the MCP loopback catalog (the CLI-coding-agent tool list).
// - read/write/edit/apply_patch/exec/process: CLI-mode providers have their own
//   native equivalents, so OpenClaw's versions would conflict.
// - continue_work/request_compaction: continuation is an INTERNAL primitive the
//   inferring session elects for itself; it is not something an external/CLI
//   caller should drive. They stay registered in the
//   gateway catalog (for /status, doctor, policy, child-inheritance) but are kept
//   out of the loopback surface here.
const NATIVE_TOOL_EXCLUDE = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "continue_work",
  "request_compaction",
]);

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
  sessionId?: string;
  yieldContextCacheKey?: string;
  onYield?: (message: string) => Promise<void> | void;
  messageProvider: string | undefined;
  clientCaps?: string[];
  currentChannelId: string | undefined;
  currentThreadTs: string | undefined;
  currentMessageId: string | number | undefined;
  currentInboundAudio: boolean | undefined;
  accountId: string | undefined;
  inboundEventKind: InboundEventKind | undefined;
  sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  requireExplicitMessageTarget?: boolean;
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
    // Callers differing only in capabilities must not share cached tool lists.
    const clientCapsCacheKey = [...new Set(params.clientCaps ?? [])].toSorted().join(",");
    const cacheKey = [
      params.sessionKey,
      params.sessionId ?? "",
      params.yieldContextCacheKey ?? "",
      params.messageProvider ?? "",
      clientCapsCacheKey,
      params.currentChannelId ?? "",
      params.currentThreadTs ?? "",
      params.currentMessageId != null ? String(params.currentMessageId) : "",
      params.currentInboundAudio === true ? "audio" : "no-audio",
      params.accountId ?? "",
      params.inboundEventKind ?? "",
      params.sourceReplyDeliveryMode ?? "",
      params.taskSuggestionDeliveryMode ?? "",
      params.requireExplicitMessageTarget === true ? "explicit-message-target" : "",
      params.senderIsOwner === true
        ? "owner"
        : params.senderIsOwner === false
          ? "non-owner"
          : "unknown-owner",
    ].join("\u0000");
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (now - entry.time >= TOOL_CACHE_TTL_MS) {
        this.#entries.delete(key);
      }
    }
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
    while (this.#entries.size > TOOL_CACHE_MAX_ENTRIES) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.#entries.delete(oldestKey);
    }
    return nextEntry;
  }
}
