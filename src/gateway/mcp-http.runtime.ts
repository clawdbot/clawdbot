// MCP loopback runtime scope cache.
// Resolves Gateway-visible tools for MCP clients with short-lived schema caching.
import type { ExecElevatedDefaults } from "../agents/bash-tools.exec-types.js";
import type { ExecPolicyOverrides, ExecSessionDefaults } from "../agents/exec-defaults.js";
import { normalizeToolName } from "../agents/tool-policy.js";
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginHookChannelContext } from "../plugins/hook-types.js";
import {
  buildMcpToolSchema,
  readMcpLoopbackToolName,
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
  runtimePolicySessionKey?: string;
  agentId?: string;
  sessionId?: string;
  modelProvider?: string;
  modelId?: string;
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
  /** Per-run grant allowlist of gateway tool names; unset keeps full scope. */
  toolsAllow?: string[];
  senderIsOwner: boolean | undefined;
  nodeExecAllowed?: boolean;
  execSession?: ExecSessionDefaults;
  execOverrides?: ExecPolicyOverrides;
  bashElevated?: ExecElevatedDefaults;
  trigger?: string;
  approvalReviewerDeviceId?: string;
  channelContext?: PluginHookChannelContext;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  spawnedBy?: string;
};

/** Resolves loopback-visible tools after applying gateway scope and native-tool exclusions. */
export function resolveMcpLoopbackScopedTools(params: McpLoopbackScopeParams): {
  agentId: string | undefined;
  tools: McpLoopbackTool[];
} {
  const excludeToolNames = new Set(NATIVE_TOOL_EXCLUDE);
  // Restricted CLI grants use OpenClaw's implementations for coding tools;
  // native CLI tools bypass path, approval, sandbox, and exec policy.
  const mediatedNativeTools = new Set(
    (params.toolsAllow ?? [])
      .map((name) => normalizeToolName(name))
      .filter((name) => NATIVE_TOOL_EXCLUDE.has(name)),
  );
  for (const toolName of mediatedNativeTools) {
    excludeToolNames.delete(toolName);
  }
  const includeNodeExecTool = params.nodeExecAllowed === true && mediatedNativeTools.size === 0;
  if (includeNodeExecTool) {
    excludeToolNames.delete("exec");
  }
  const scoped = resolveGatewayScopedTools({
    ...params,
    conversationReadOrigin: "delegated",
    surface: "loopback",
    excludeToolNames,
    includeNodeExecTool,
  });
  return {
    agentId: scoped.agentId,
    tools: applyGrantToolsAllow(scoped.tools, params.toolsAllow),
  };
}

/**
 * Hard-enforces a per-run grant allowlist on the loopback surface. Both
 * tools/list and tools/call consume this list, so a tool outside the
 * allowlist can be neither discovered nor executed even when the CLI runs
 * with a bypass permission mode. An empty allowlist fails closed.
 */
function applyGrantToolsAllow(
  tools: McpLoopbackTool[],
  toolsAllow: string[] | undefined,
): McpLoopbackTool[] {
  if (!toolsAllow) {
    return tools;
  }
  const allowed = new Set(toolsAllow.map((name) => normalizeToolName(name)).filter(Boolean));
  return tools.filter((tool) => {
    const name = readMcpLoopbackToolName(tool);
    return name !== undefined && allowed.has(normalizeToolName(name));
  });
}

/** Short-lived cache for loopback tool lists keyed by session/channel context. */
export class McpLoopbackToolCache {
  #entries = new Map<string, CachedScopedTools>();

  resolve(params: McpLoopbackScopeParams): CachedScopedTools {
    // Callers differing only in capabilities must not share cached tool lists.
    const clientCapsCacheKey = [...new Set(params.clientCaps ?? [])].toSorted().join(",");
    const cacheKey = [
      params.sessionKey,
      params.runtimePolicySessionKey ?? "",
      params.agentId ?? "",
      params.sessionId ?? "",
      params.modelProvider ?? "",
      params.modelId ?? "",
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
      // Unset (full scope) must never share a cache row with an empty
      // allowlist (deny-all), so the marker distinguishes presence.
      params.toolsAllow ? `allow:${[...new Set(params.toolsAllow)].toSorted().join(",")}` : "",
      params.nodeExecAllowed === true ? "node-exec" : "",
      params.execSession?.execHost ?? "",
      params.execSession?.execSecurity ?? "",
      params.execSession?.execAsk ?? "",
      params.execSession?.execNode ?? "",
      params.execOverrides?.host ?? "",
      params.execOverrides?.security ?? "",
      params.execOverrides?.ask ?? "",
      params.execOverrides?.node ?? "",
      params.bashElevated ? "elevated-present" : "elevated-absent",
      params.bashElevated?.enabled === true ? "elevated-enabled" : "elevated-disabled",
      params.bashElevated?.allowed === true ? "elevated-allowed" : "elevated-blocked",
      params.bashElevated?.defaultLevel ?? "",
      params.bashElevated?.fullAccessAvailable === true
        ? "full-access-available"
        : params.bashElevated?.fullAccessAvailable === false
          ? "full-access-unavailable"
          : "",
      params.bashElevated?.fullAccessBlockedReason ?? "",
      params.trigger ?? "",
      params.approvalReviewerDeviceId ?? "",
      params.channelContext?.sender?.id ?? "",
      params.channelContext?.chat?.id ?? "",
      params.senderName ?? "",
      params.senderUsername ?? "",
      params.senderE164 ?? "",
      params.groupId ?? "",
      params.groupChannel ?? "",
      params.groupSpace ?? "",
      params.spawnedBy ?? "",
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
