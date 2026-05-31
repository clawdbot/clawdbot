import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateToolsEffectiveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { buildEffectiveToolInventoryGroups } from "../../agents/tools-effective-inventory-groups.js";
import type {
  EffectiveToolInventoryNotice,
  EffectiveToolInventoryResult,
} from "../../agents/tools-effective-inventory.types.js";
import { buildRuntimeCompatibleMcpToolInventory } from "../../agents/tools-effective-mcp-inventory.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logDebug, logWarn } from "../../logger.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import {
  applyFinalEffectiveToolPolicy,
  buildBundleMcpToolsFromCatalog,
  deliveryContextFromSession,
  getActivePluginChannelRegistryVersion,
  getActivePluginRegistryVersion,
  listAgentIds,
  loadSessionEntry,
  peekSessionMcpRuntime,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveEffectiveToolInventory,
  resolveEffectiveToolInventoryRuntimeModelContext,
  resolveReplyToMode,
  resolveRuntimeConfigCacheKey,
  resolveSessionAgentId,
  resolveSessionMcpConfigSummary,
  resolveSessionModelRef,
} from "./tools-effective.runtime.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const TOOLS_EFFECTIVE_FRESH_TTL_MS = 10_000;
const TOOLS_EFFECTIVE_STALE_TTL_MS = 120_000;
const TOOLS_EFFECTIVE_SLOW_LOG_MS = 250;
const TOOLS_EFFECTIVE_CACHE_LIMIT = 128;
const MCP_CONFIG_SUMMARY_CACHE_LIMIT = 128;

let nowForToolsEffectiveCache = () => Date.now();

type TrustedToolsEffectiveContext = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  workspaceDir: string;
  runtimeConfigCacheKey: string;
  pluginRegistryVersion: number;
  channelRegistryVersion: number;
  modelProvider?: string;
  modelId?: string;
  messageProvider?: string;
  accountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  replyToMode?: "off" | "first" | "all" | "batched";
  spawnedBy?: string | null;
};

type ToolsEffectiveCacheEntry = {
  value: EffectiveToolInventoryResult;
  createdAtMs: number;
};

type SessionMcpConfigSummary = ReturnType<typeof resolveSessionMcpConfigSummary>;

const toolsEffectiveCache = new Map<string, ToolsEffectiveCacheEntry>();
const toolsEffectiveInflight = new Map<string, Promise<EffectiveToolInventoryResult>>();
const mcpConfigSummaryCache = new Map<string, SessionMcpConfigSummary>();

function optionalCacheString(value: string | undefined | null): string {
  return value?.trim() ?? "";
}

function buildToolsEffectiveCacheKey(params: {
  sessionKey: string;
  context: TrustedToolsEffectiveContext;
}): string {
  const context = params.context;
  return JSON.stringify({
    v: 1,
    config: context.runtimeConfigCacheKey,
    pluginRegistry: context.pluginRegistryVersion,
    channelRegistry: context.channelRegistryVersion,
    // MCP fingerprint/server names intentionally stay out of this key: the MCP
    // layer is applied after the base cache, so warm/stale runtime state alone
    // never invalidates base entries.
    sessionKey: params.sessionKey,
    workspaceDir: optionalCacheString(context.workspaceDir),
    agentId: context.agentId,
    modelProvider: optionalCacheString(context.modelProvider),
    modelId: optionalCacheString(context.modelId),
    messageProvider: optionalCacheString(context.messageProvider),
    accountId: optionalCacheString(context.accountId),
    currentChannelId: optionalCacheString(context.currentChannelId),
    currentThreadTs: optionalCacheString(context.currentThreadTs),
    groupId: optionalCacheString(context.groupId),
    groupChannel: optionalCacheString(context.groupChannel),
    groupSpace: optionalCacheString(context.groupSpace),
    replyToMode: optionalCacheString(context.replyToMode),
  });
}

function trimToolsEffectiveCache(): void {
  while (toolsEffectiveCache.size > TOOLS_EFFECTIVE_CACHE_LIMIT) {
    const oldest = toolsEffectiveCache.keys().next().value;
    if (typeof oldest !== "string") {
      return;
    }
    toolsEffectiveCache.delete(oldest);
  }
}

function buildMcpConfigSummaryCacheKey(params: {
  context: TrustedToolsEffectiveContext;
  workspaceDir: string;
}): string {
  return JSON.stringify({
    v: 1,
    config: params.context.runtimeConfigCacheKey,
    pluginRegistry: params.context.pluginRegistryVersion,
    workspaceDir: params.workspaceDir,
  });
}

function trimMcpConfigSummaryCache(): void {
  while (mcpConfigSummaryCache.size > MCP_CONFIG_SUMMARY_CACHE_LIMIT) {
    const oldest = mcpConfigSummaryCache.keys().next().value;
    if (typeof oldest !== "string") {
      return;
    }
    mcpConfigSummaryCache.delete(oldest);
  }
}

function resolveCachedSessionMcpConfigSummary(params: {
  context: TrustedToolsEffectiveContext;
  workspaceDir: string;
}): SessionMcpConfigSummary {
  const key = buildMcpConfigSummaryCacheKey(params);
  const cached = mcpConfigSummaryCache.get(key);
  if (cached) {
    return cached;
  }
  const summary = resolveSessionMcpConfigSummary({
    workspaceDir: params.workspaceDir,
    cfg: params.context.cfg,
  });
  mcpConfigSummaryCache.set(key, summary);
  trimMcpConfigSummaryCache();
  return summary;
}

function cacheToolsEffectiveResult(key: string, value: EffectiveToolInventoryResult): void {
  toolsEffectiveCache.delete(key);
  toolsEffectiveCache.set(key, { value, createdAtMs: nowForToolsEffectiveCache() });
  trimToolsEffectiveCache();
}

function scheduleBaseToolsEffectiveRefresh(
  key: string,
  context: TrustedToolsEffectiveContext,
): Promise<EffectiveToolInventoryResult> {
  const existing = toolsEffectiveInflight.get(key);
  if (existing) {
    return existing;
  }
  const startedAt = nowForToolsEffectiveCache();
  const task = new Promise<EffectiveToolInventoryResult>((resolve, reject) => {
    setImmediate(() => {
      try {
        const value = resolveBaseToolsEffectiveInventory(context);
        cacheToolsEffectiveResult(key, value);
        const durationMs = nowForToolsEffectiveCache() - startedAt;
        if (durationMs >= TOOLS_EFFECTIVE_SLOW_LOG_MS) {
          logDebug(
            `tools-effective: refresh durationMs=${durationMs} agent=${context.agentId} session=${context.sessionKey} tools=${value.groups.reduce((sum, group) => sum + group.tools.length, 0)}`,
          );
        }
        resolve(value);
      } catch (err) {
        reject(err);
      } finally {
        toolsEffectiveInflight.delete(key);
      }
    });
  });
  toolsEffectiveInflight.set(key, task);
  return task;
}

function refreshBaseToolsEffectiveInBackground(
  key: string,
  context: TrustedToolsEffectiveContext,
): void {
  void scheduleBaseToolsEffectiveRefresh(key, context).catch((err) => {
    logWarn(`tools-effective: background refresh failed: ${String(err)}`);
  });
}

async function resolveCachedBaseToolsEffective(params: {
  sessionKey: string;
  context: TrustedToolsEffectiveContext;
}): Promise<EffectiveToolInventoryResult> {
  const key = buildToolsEffectiveCacheKey(params);
  const now = nowForToolsEffectiveCache();
  const cached = toolsEffectiveCache.get(key);
  if (cached) {
    const ageMs = now - cached.createdAtMs;
    if (ageMs < TOOLS_EFFECTIVE_FRESH_TTL_MS) {
      return cached.value;
    }
    if (ageMs < TOOLS_EFFECTIVE_STALE_TTL_MS) {
      refreshBaseToolsEffectiveInBackground(key, params.context);
      return cached.value;
    }
  }
  return scheduleBaseToolsEffectiveRefresh(key, params.context);
}

function resolveRequestedAgentIdOrRespondError(params: {
  rawAgentId: unknown;
  cfg: OpenClawConfig;
  respond: RespondFn;
}) {
  const knownAgents = listAgentIds(params.cfg);
  const requestedAgentId = normalizeOptionalString(params.rawAgentId) ?? "";
  if (!requestedAgentId) {
    return undefined;
  }
  if (!knownAgents.includes(requestedAgentId)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return requestedAgentId;
}

function appendMcpInventoryGroups(params: {
  base: EffectiveToolInventoryResult;
  mcpInventory: ReturnType<typeof buildRuntimeCompatibleMcpToolInventory>;
}): EffectiveToolInventoryResult {
  const mcpEntries = params.mcpInventory.entries.filter((entry) => entry.source === "mcp");
  const notices = [...(params.base.notices ?? []), ...params.mcpInventory.notices];
  const base = notices.length > 0 ? { ...params.base, notices } : params.base;
  if (mcpEntries.length === 0) {
    return base;
  }
  const mcpGroups = buildEffectiveToolInventoryGroups(mcpEntries);
  return {
    ...base,
    groups: [...base.groups, ...mcpGroups],
  };
}

function appendToolInventoryNotice(
  base: EffectiveToolInventoryResult,
  notice: EffectiveToolInventoryNotice,
): EffectiveToolInventoryResult {
  return {
    ...base,
    notices: [...(base.notices ?? []), notice],
  };
}

function formatMcpServerNames(names: readonly string[]): string {
  if (names.length === 0) {
    return "configured MCP servers";
  }
  const visible = names
    .slice(0, 3)
    .map((name) => `"${name}"`)
    .join(", ");
  return names.length > 3 ? `${visible}, and ${names.length - 3} more MCP servers` : visible;
}

function mcpDiscoveryNotice(
  mcpServerNames: string[],
  reason: "not-connected" | "not-listed" | "stale-config",
): EffectiveToolInventoryNotice | undefined {
  if (mcpServerNames.length === 0) {
    return undefined;
  }
  const servers = formatMcpServerNames(mcpServerNames);
  switch (reason) {
    case "stale-config":
      return {
        id: "mcp-stale-catalog",
        severity: "info",
        message: `MCP servers ${servers} changed since the current runtime catalog was discovered. MCP tools will appear here after the next agent run discovers them.`,
      };
    case "not-listed":
      return {
        id: "mcp-not-yet-listed",
        severity: "info",
        message: `MCP servers ${servers} are connected but have not finished listing tools yet. MCP tools will appear here after the session discovers them.`,
      };
    case "not-connected":
      return {
        id: "mcp-not-yet-connected",
        severity: "info",
        message: `MCP servers ${servers} are configured but not connected for this session yet. MCP tools will appear here after an agent run discovers them.`,
      };
    default:
      // Exhaustiveness guard for oxlint's consistent-return rule.
      return undefined;
  }
}

function maybeAppendMcpNotice(
  base: EffectiveToolInventoryResult,
  mcpServerNames: string[],
  reason: "not-connected" | "not-listed" | "stale-config",
): EffectiveToolInventoryResult {
  const notice = mcpDiscoveryNotice(mcpServerNames, reason);
  return notice ? appendToolInventoryNotice(base, notice) : base;
}

function resolveBaseToolsEffectiveInventory(
  context: TrustedToolsEffectiveContext,
): EffectiveToolInventoryResult {
  const agentDir = resolveAgentDir(context.cfg, context.agentId);
  const runtimeModelContext = resolveEffectiveToolInventoryRuntimeModelContext({
    cfg: context.cfg,
    agentId: context.agentId,
    agentDir,
    workspaceDir: context.workspaceDir,
    modelProvider: context.modelProvider,
    modelId: context.modelId,
  });
  return resolveEffectiveToolInventory({
    cfg: context.cfg,
    agentId: context.agentId,
    agentDir,
    sessionKey: context.sessionKey,
    workspaceDir: context.workspaceDir,
    messageProvider: context.messageProvider,
    modelProvider: context.modelProvider,
    modelId: context.modelId,
    modelApi: runtimeModelContext.modelApi,
    runtimeModel: runtimeModelContext.runtimeModel,
    currentChannelId: context.currentChannelId,
    currentThreadTs: context.currentThreadTs,
    accountId: context.accountId,
    groupId: context.groupId,
    groupChannel: context.groupChannel,
    groupSpace: context.groupSpace,
    replyToMode: context.replyToMode,
  });
}

function filterMcpTools(params: {
  context: TrustedToolsEffectiveContext;
  mcpTools: Parameters<typeof applyFinalEffectiveToolPolicy>[0]["bundledTools"];
}) {
  return applyFinalEffectiveToolPolicy({
    bundledTools: params.mcpTools,
    config: params.context.cfg,
    sessionKey: params.context.sessionKey,
    agentId: params.context.agentId,
    modelProvider: params.context.modelProvider,
    modelId: params.context.modelId,
    messageProvider: params.context.messageProvider,
    agentAccountId: params.context.accountId,
    groupId: params.context.groupId,
    groupChannel: params.context.groupChannel,
    groupSpace: params.context.groupSpace,
    spawnedBy: params.context.spawnedBy,
    warn: logWarn,
  });
}

async function resolveReadOnlyToolsEffectiveInventory(
  context: TrustedToolsEffectiveContext,
): Promise<EffectiveToolInventoryResult> {
  const base = await resolveCachedBaseToolsEffective({
    sessionKey: context.sessionKey,
    context,
  });
  // UI panel loads call `tools.effective`, so this path must not create MCP
  // runtimes, connect transports, or issue tools/list. It only projects an
  // already-warm session catalog.
  const runtime = peekSessionMcpRuntime({
    sessionId: context.sessionId,
    sessionKey: context.sessionKey,
  });
  // Runtime workspaces may be sandbox copies. Compare against the same
  // workspace-derived MCP summary that created the runtime, or warm sandbox
  // catalogs look stale forever.
  const mcpConfig = resolveCachedSessionMcpConfigSummary({
    context,
    workspaceDir: runtime?.workspaceDir ?? context.workspaceDir,
  });
  if (mcpConfig.serverNames.length === 0) {
    return base;
  }
  if (!runtime) {
    return maybeAppendMcpNotice(base, mcpConfig.serverNames, "not-connected");
  }
  if (runtime.configFingerprint !== mcpConfig.fingerprint) {
    return maybeAppendMcpNotice(base, mcpConfig.serverNames, "stale-config");
  }
  // Cached catalog only; a missing catalog is a notice, not a discovery trigger.
  const catalog = runtime.peekCatalog();
  if (!catalog) {
    return maybeAppendMcpNotice(base, mcpConfig.serverNames, "not-listed");
  }
  const projectedMcpTools = buildBundleMcpToolsFromCatalog({
    catalog,
    reservedToolNames: base.groups.flatMap((group) => group.tools.map((tool) => tool.id)),
  });
  const filteredMcpTools = filterMcpTools({ context, mcpTools: projectedMcpTools });
  const agentDir = resolveAgentDir(context.cfg, context.agentId);
  const runtimeModelContext = resolveEffectiveToolInventoryRuntimeModelContext({
    cfg: context.cfg,
    agentId: context.agentId,
    agentDir,
    workspaceDir: runtime.workspaceDir,
    modelProvider: context.modelProvider,
    modelId: context.modelId,
  });
  const mcpInventory = buildRuntimeCompatibleMcpToolInventory({
    tools: filteredMcpTools,
    cfg: context.cfg,
    workspaceDir: runtime.workspaceDir,
    modelProvider: context.modelProvider,
    modelId: context.modelId,
    modelApi: runtimeModelContext.modelApi,
    runtimeModel: runtimeModelContext.runtimeModel,
  });
  return appendMcpInventoryGroups({ base, mcpInventory });
}

function resolveTrustedToolsEffectiveContext(params: {
  sessionKey: string;
  requestedAgentId?: string;
  respond: RespondFn;
}) {
  const loaded = loadSessionEntry(params.sessionKey);
  if (!loaded.entry) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session key "${params.sessionKey}"`),
    );
    return null;
  }

  const sessionAgentId = resolveSessionAgentId({
    sessionKey: loaded.canonicalKey ?? params.sessionKey,
    config: loaded.cfg,
  });
  if (params.requestedAgentId && params.requestedAgentId !== sessionAgentId) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `agent id "${params.requestedAgentId}" does not match session agent "${sessionAgentId}"`,
      ),
    );
    return null;
  }

  const delivery = deliveryContextFromSession(loaded.entry);
  const resolvedModel = resolveSessionModelRef(loaded.cfg, loaded.entry, sessionAgentId);
  const workspaceDir =
    normalizeOptionalString(loaded.entry.spawnedWorkspaceDir) ??
    resolveAgentWorkspaceDir(loaded.cfg, sessionAgentId);
  const runtimeConfigCacheKey = resolveRuntimeConfigCacheKey(loaded.cfg);
  const pluginRegistryVersion = getActivePluginRegistryVersion();
  const channelRegistryVersion = getActivePluginChannelRegistryVersion();
  return {
    cfg: loaded.cfg,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    sessionId: loaded.entry.sessionId,
    workspaceDir,
    runtimeConfigCacheKey,
    pluginRegistryVersion,
    channelRegistryVersion,
    modelProvider: resolvedModel.provider,
    modelId: resolvedModel.model,
    messageProvider:
      delivery?.channel ??
      loaded.entry.lastChannel ??
      loaded.entry.channel ??
      loaded.entry.origin?.provider,
    accountId: delivery?.accountId ?? loaded.entry.lastAccountId ?? loaded.entry.origin?.accountId,
    currentChannelId: delivery?.to,
    currentThreadTs:
      delivery?.threadId != null
        ? stringifyRouteThreadId(delivery.threadId)
        : loaded.entry.lastThreadId != null
          ? stringifyRouteThreadId(loaded.entry.lastThreadId)
          : loaded.entry.origin?.threadId != null
            ? stringifyRouteThreadId(loaded.entry.origin.threadId)
            : undefined,
    groupId: loaded.entry.groupId,
    groupChannel: loaded.entry.groupChannel,
    groupSpace: loaded.entry.space,
    spawnedBy: normalizeOptionalString(loaded.entry.spawnedBy),
    replyToMode: resolveReplyToMode(
      loaded.cfg,
      delivery?.channel ??
        loaded.entry.lastChannel ??
        loaded.entry.channel ??
        loaded.entry.origin?.provider,
      delivery?.accountId ?? loaded.entry.lastAccountId ?? loaded.entry.origin?.accountId,
      loaded.entry.chatType ?? loaded.entry.origin?.chatType,
    ),
  };
}

async function handleToolsEffectiveRequest(params: {
  rawParams: unknown;
  respond: RespondFn;
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"];
}) {
  if (!validateToolsEffectiveParams(params.rawParams)) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid tools.effective params: ${formatValidationErrors(validateToolsEffectiveParams.errors)}`,
      ),
    );
    return;
  }
  const cfg = params.context.getRuntimeConfig();
  const requestedAgentId = resolveRequestedAgentIdOrRespondError({
    rawAgentId: params.rawParams.agentId,
    cfg,
    respond: params.respond,
  });
  if (requestedAgentId === null) {
    return;
  }
  const trustedContext = resolveTrustedToolsEffectiveContext({
    sessionKey: params.rawParams.sessionKey,
    requestedAgentId,
    respond: params.respond,
  });
  if (!trustedContext) {
    return;
  }
  try {
    params.respond(true, await resolveReadOnlyToolsEffectiveInventory(trustedContext), undefined);
  } catch (err) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, `tools.effective failed: ${String(err)}`),
    );
  }
}

export const toolsEffectiveHandlers: GatewayRequestHandlers = {
  "tools.effective": async ({ params, respond, context }) => {
    await handleToolsEffectiveRequest({
      rawParams: params,
      respond,
      context,
    });
  },
};

export const testing = {
  resetToolsEffectiveCacheForTest() {
    toolsEffectiveCache.clear();
    toolsEffectiveInflight.clear();
    mcpConfigSummaryCache.clear();
  },
  setToolsEffectiveNowForTest(now: () => number) {
    nowForToolsEffectiveCache = now;
  },
  resetToolsEffectiveNowForTest() {
    nowForToolsEffectiveCache = () => Date.now();
  },
} as const;
export { testing as __testing };
