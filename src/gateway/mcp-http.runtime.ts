import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
// MCP loopback runtime scope cache.
// Resolves Gateway-visible tools for MCP clients with short-lived schema caching.
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DirectoryCache } from "../infra/outbound/directory-cache.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import type { McpLoopbackRequestContext } from "./mcp-grant-store.js";
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
const NATIVE_TOOL_EXCLUDE = new Set(["read", "write", "edit", "apply_patch", "exec", "process"]);

type CachedScopedTools = {
  agentId: string | undefined;
  // Tool policy resolves the workspace root (grant value, else the agent's
  // configured workspace). Hook context must carry the same one the tools were
  // built with, or before-tool-call policy resolves state against a different root.
  workspaceDir: string | undefined;
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
};

type McpLoopbackScopeParams = Omit<McpLoopbackRequestContext, "senderIsOwner"> & {
  cfg: OpenClawConfig;
  authProfileStore?: AuthProfileStore;
  authProfileStoreAgentDir?: string;
  grantToken?: string;
  senderIsOwner: boolean | undefined;
  yieldContextCacheKey?: string;
  onYield?: (message: string, acknowledgment?: string) => Promise<void> | void;
};

type LoopbackToolsAllowMode = "exact" | "policy";

function resolveMediatedNativeTools(
  toolsAllow: string[] | undefined,
  mode: LoopbackToolsAllowMode,
): Set<string> {
  if (mode === "exact") {
    return new Set(
      (toolsAllow ?? [])
        .map((name) => normalizeToolPolicyName(name))
        .filter((name) => NATIVE_TOOL_EXCLUDE.has(name)),
    );
  }
  if (
    toolsAllow === undefined ||
    toolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*")
  ) {
    return new Set();
  }
  return new Set(
    applyEmbeddedAttemptToolsAllow(
      Array.from(NATIVE_TOOL_EXCLUDE, (name) => ({ name })),
      toolsAllow,
    ).map((tool) => tool.name),
  );
}

function resolveMcpLoopbackTools(
  params: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): {
  agentId: string | undefined;
  workspaceDir?: string;
  tools: McpLoopbackTool[];
} {
  const excludeToolNames = new Set(NATIVE_TOOL_EXCLUDE);
  // Restricted CLI grants use OpenClaw's implementations for coding tools;
  // native CLI tools bypass path, approval, sandbox, and exec policy.
  const mediatedNativeTools = resolveMediatedNativeTools(params.toolsAllow, mode);
  for (const toolName of mediatedNativeTools) {
    excludeToolNames.delete(toolName);
  }
  const includeNodeExecTool = params.nodeExecAllowed === true && mediatedNativeTools.size === 0;
  if (includeNodeExecTool) {
    excludeToolNames.delete("exec");
  }
  const {
    toolsAllow: _toolsAllow,
    authProfileStoreAgentDir,
    grantToken: _grantToken,
    ...scopeParams
  } = params;
  const scoped = resolveGatewayScopedTools({
    ...scopeParams,
    agentDir: authProfileStoreAgentDir,
    conversationReadOrigin: "delegated",
    surface: "loopback",
    excludeToolNames,
    mediatedToolNames: mediatedNativeTools,
    includeNodeExecTool,
  });
  return {
    agentId: scoped.agentId,
    workspaceDir: scoped.workspaceDir,
    tools:
      mode === "exact"
        ? applyGrantToolsAllow(scoped.tools, params.toolsAllow)
        : applyPolicyToolsAllow(scoped.tools, params.toolsAllow),
  };
}

/** Resolves loopback-visible tools from the exact names carried by a minted grant. */
export function resolveMcpLoopbackScopedTools(params: McpLoopbackScopeParams): {
  agentId: string | undefined;
  workspaceDir?: string;
  tools: McpLoopbackTool[];
} {
  return resolveMcpLoopbackTools(params, "exact");
}

/** Materializes runtime policy expressions against the concrete loopback catalog. */
export function resolveMcpLoopbackPolicyTools(params: McpLoopbackScopeParams): {
  agentId: string | undefined;
  tools: McpLoopbackTool[];
} {
  return resolveMcpLoopbackTools(params, "policy");
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
  const allowed = new Set(toolsAllow.map((name) => normalizeToolPolicyName(name)).filter(Boolean));
  return tools.filter((tool) => {
    const name = readMcpLoopbackToolName(tool);
    return name !== undefined && allowed.has(normalizeToolPolicyName(name));
  });
}

function applyPolicyToolsAllow(
  tools: McpLoopbackTool[],
  toolsAllow: string[] | undefined,
): McpLoopbackTool[] {
  if (!toolsAllow) {
    return tools;
  }
  // Grant lists remain exact; only this pre-mint path may expand groups,
  // globs, plugin ids, and write-to-apply_patch policy semantics.
  const candidates = tools.flatMap((tool) => {
    const name = readMcpLoopbackToolName(tool);
    return name ? [{ name, tool }] : [];
  });
  return applyEmbeddedAttemptToolsAllow(candidates, toolsAllow, {
    toolMeta: (candidate) => getPluginToolMeta(candidate.tool),
  }).map((candidate) => candidate.tool);
}

/** Short-lived cache for loopback tool lists keyed by session/channel context. */
export class McpLoopbackToolCache {
  #entries = new DirectoryCache<CachedScopedTools>(TOOL_CACHE_TTL_MS, TOOL_CACHE_MAX_ENTRIES);
  // Revocation needs the config scopes where one grant may have cached tools.
  #grantConfigScopes = new Map<string, Set<OpenClawConfig>>();

  resolve(params: McpLoopbackScopeParams): CachedScopedTools {
    // Callers differing only in capabilities must not share cached tool lists.
    const clientCapsCacheKey = [...new Set(params.clientCaps ?? [])].toSorted().join(",");
    const cacheKey = [
      params.grantToken ?? "",
      params.sessionKey,
      params.runtimePolicySessionKey ?? "",
      params.runtimePolicyAgentId ?? "",
      params.agentId ?? "",
      params.sessionId ?? "",
      params.runId ?? "",
      params.workspaceDir ?? "",
      params.cwd ?? "",
      params.modelProvider ?? "",
      params.modelId ?? "",
      params.modelHasVision === true ? "vision" : "text-only",
      params.yieldContextCacheKey ?? "",
      params.messageProvider ?? "",
      clientCapsCacheKey,
      params.currentChannelId ?? "",
      params.currentThreadTs ?? "",
      params.currentMessageId ?? "",
      params.replyToMode ?? "",
      params.currentInboundAudio === true ? "audio" : "no-audio",
      params.accountId ?? "",
      params.inboundEventKind ?? "",
      params.sourceReplyDeliveryMode ?? "",
      params.sourceReplyOnly === true ? "source-reply-only" : "",
      params.taskSuggestionDeliveryMode ?? "",
      params.requireExplicitMessageTarget === true ? "explicit-message-target" : "",
      // Unset (full scope) must never share a cache row with an empty
      // allowlist (deny-all), so the marker distinguishes presence.
      params.toolsAllow ? `allow:${[...new Set(params.toolsAllow)].toSorted().join(",")}` : "",
      JSON.stringify(params.skillWorkshop?.proposalRevision ?? null),
      JSON.stringify(params.scheduledToolPolicy ?? null),
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
    const cached = this.#entries.get(cacheKey, params.cfg);
    if (cached) {
      return cached;
    }

    const next = resolveMcpLoopbackScopedTools(params);
    const nextEntry: CachedScopedTools = {
      agentId: next.agentId,
      workspaceDir: next.workspaceDir,
      tools: next.tools,
      toolSchema: buildMcpToolSchema(next.tools),
    };
    this.#entries.set(cacheKey, nextEntry, params.cfg);
    if (params.grantToken) {
      const scopes = this.#grantConfigScopes.get(params.grantToken) ?? new Set<OpenClawConfig>();
      scopes.add(params.cfg);
      this.#grantConfigScopes.set(params.grantToken, scopes);
    }
    return nextEntry;
  }

  evictGrant(token: string): boolean {
    const scopes = this.#grantConfigScopes.get(token);
    if (!scopes) {
      return false;
    }
    const cacheKeyPrefix = `${token}\u0000`;
    for (const cfg of scopes) {
      this.#entries.clearMatching((cacheKey) => cacheKey.startsWith(cacheKeyPrefix), cfg);
    }
    this.#grantConfigScopes.delete(token);
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#grantConfigScopes.clear();
  }
}
