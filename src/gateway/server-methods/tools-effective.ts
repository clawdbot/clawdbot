// Effective tools methods resolve the tools available to a session by combining
// bundled tools, MCP tools, plugin policy, model context, and cache state.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateToolsEffectiveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { buildEffectiveToolInventoryGroups } from "../../agents/tools-effective-inventory-groups.js";
import type {
  EffectiveToolInventoryNotice,
  EffectiveToolInventoryResult,
} from "../../agents/tools-effective-inventory.types.js";
import { buildRuntimeCompatibleMcpToolInventory } from "../../agents/tools-effective-mcp-inventory.js";
import type { SessionToolOverrides } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { toErrorObject } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { logDebug, logWarn } from "../../logger.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.shared.js";
import { getConnectedNodePluginToolsVersion } from "../node-plugin-tool-snapshot.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  applyFinalEffectiveToolPolicy,
  buildBundleMcpToolsFromCatalog,
  deliveryContextFromSession,
  getActivePluginChannelRegistryVersion,
  getActivePluginRegistryVersion,
  getRegisteredAgentHarness,
  listAgentIds,
  loadGatewaySessionEntryReadOnly,
  peekSessionMcpRuntime,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveEffectiveToolInventory,
  resolveEffectiveToolInventoryRuntimeModelContextAsync,
  resolveReplyToMode,
  resolveRuntimeConfigCacheKey,
  resolveSessionAgentId,
  resolveSessionMcpConfigSummary,
  resolveSessionModelRef,
} from "./tools-effective.runtime.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

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
  nodePluginToolsVersion: number;
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
  agentHarnessId?: string;
  toolOverrides?: SessionToolOverrides;
};

type ToolsEffectiveCacheEntry = {
  value: BaseToolsEffectiveResolution;
  createdAtMs: number;
};

type RuntimeModelContext = Awaited<
  ReturnType<typeof resolveEffectiveToolInventoryRuntimeModelContextAsync>
>;

type BaseToolsEffectiveResolution = {
  inventory: EffectiveToolInventoryResult;
  runtimeModelContext: RuntimeModelContext;
};

type SessionMcpConfigSummary = ReturnType<typeof resolveSessionMcpConfigSummary>;

const toolsEffectiveCache = new Map<string, ToolsEffectiveCacheEntry>();
const toolsEffectiveInflight = new Map<string, Promise<BaseToolsEffectiveResolution>>();
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
    nodePluginTools: context.nodePluginToolsVersion,
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

function buildMcpConfigSummaryCacheKey(params: {
  context: TrustedToolsEffectiveContext;
  workspaceDir: string;
}): string {
  return JSON.stringify({
    v: 1,
    config: params.context.runtimeConfigCacheKey,
    pluginRegistry: params.context.pluginRegistryVersion,
    workspaceDir: params.workspaceDir,
    toolOverrides: params.context.toolOverrides,
  });
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
    ...(params.context.toolOverrides ? { toolOverrides: params.context.toolOverrides } : {}),
  });
  mcpConfigSummaryCache.set(key, summary);
  pruneMapToMaxSize(mcpConfigSummaryCache, MCP_CONFIG_SUMMARY_CACHE_LIMIT);
  return summary;
}

function cacheToolsEffectiveResult(key: string, value: BaseToolsEffectiveResolution): void {
  toolsEffectiveCache.delete(key);
  toolsEffectiveCache.set(key, { value, createdAtMs: nowForToolsEffectiveCache() });
  pruneMapToMaxSize(toolsEffectiveCache, TOOLS_EFFECTIVE_CACHE_LIMIT);
}

// Base inventory resolution is pure CPU work, but it can still fan through
// config/model policy. Coalesce identical refreshes so UI polling does not
// recompute the same session inventory in parallel.
function scheduleBaseToolsEffectiveRefresh(
  key: string,
  context: TrustedToolsEffectiveContext,
): Promise<BaseToolsEffectiveResolution> {
  const existing = toolsEffectiveInflight.get(key);
  if (existing) {
    return existing;
  }
  const startedAt = nowForToolsEffectiveCache();
  const task = new Promise<BaseToolsEffectiveResolution>((resolve, reject) => {
    setImmediate(() => {
      void resolveBaseToolsEffectiveInventory(context)
        .then((value) => {
          cacheToolsEffectiveResult(key, value);
          const durationMs = nowForToolsEffectiveCache() - startedAt;
          if (durationMs >= TOOLS_EFFECTIVE_SLOW_LOG_MS) {
            logDebug(
              `tools-effective: refresh durationMs=${durationMs} agent=${context.agentId} session=${context.sessionKey} tools=${value.inventory.groups.reduce((sum, group) => sum + group.tools.length, 0)}`,
            );
          }
          resolve(value);
        })
        .catch((err: unknown) => reject(toErrorObject(err, "Non-Error rejection")))
        .finally(() => toolsEffectiveInflight.delete(key));
    });
  });
  toolsEffectiveInflight.set(key, task);
  return task;
}

function refreshBaseToolsEffectiveInBackground(
  key: string,
  context: TrustedToolsEffectiveContext,
): void {
  void scheduleBaseToolsEffectiveRefresh(key, context).catch((err: unknown) => {
    logWarn(`tools-effective: background refresh failed: ${String(err)}`);
  });
}

async function resolveCachedBaseToolsEffective(params: {
  sessionKey: string;
  context: TrustedToolsEffectiveContext;
}): Promise<BaseToolsEffectiveResolution> {
  const key = buildToolsEffectiveCacheKey(params);
  const now = nowForToolsEffectiveCache();
  const cached = toolsEffectiveCache.get(key);
  if (cached) {
    const ageMs = now - cached.createdAtMs;
    if (ageMs < TOOLS_EFFECTIVE_FRESH_TTL_MS) {
      return cached.value;
    }
    if (ageMs < TOOLS_EFFECTIVE_STALE_TTL_MS) {
      // Stale-while-revalidate keeps the tools panel responsive while a new
      // registry/config snapshot is rebuilt in the background.
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
  // MCP notices apply even when no tools are projectable; only source=mcp
  // entries become new groups beside the base runtime inventory.
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
  const servers = mcpServerNames.toSorted((a, b) => a.localeCompare(b));
  const formattedServers = formatMcpServerNames(servers);
  switch (reason) {
    case "stale-config":
      return {
        id: "mcp-stale-catalog",
        severity: "info",
        message: `MCP servers ${formattedServers} changed since the current runtime catalog was discovered. MCP tools will appear here after the next agent run discovers them.`,
        servers,
      };
    case "not-listed":
      return {
        id: "mcp-not-yet-listed",
        severity: "info",
        message: `MCP servers ${formattedServers} are connected but have not finished listing tools yet. MCP tools will appear here after the session discovers them.`,
        servers,
      };
    case "not-connected":
      return {
        id: "mcp-not-yet-connected",
        severity: "info",
        message: `MCP servers ${formattedServers} are configured but not connected for this session yet. MCP tools will appear here after an agent run discovers them.`,
        servers,
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

async function resolveBaseToolsEffectiveInventory(
  context: TrustedToolsEffectiveContext,
): Promise<BaseToolsEffectiveResolution> {
  const agentDir = resolveAgentDir(context.cfg, context.agentId);
  const runtimeModelContext = await resolveEffectiveToolInventoryRuntimeModelContextAsync({
    cfg: context.cfg,
    agentId: context.agentId,
    agentDir,
    workspaceDir: context.workspaceDir,
    modelProvider: context.modelProvider,
    modelId: context.modelId,
  });
  return {
    runtimeModelContext,
    inventory: resolveEffectiveToolInventory({
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
    }),
  };
}

function filterMcpTools(params: {
  context: TrustedToolsEffectiveContext;
  mcpTools: Parameters<typeof applyFinalEffectiveToolPolicy>[0]["bundledTools"];
}) {
  return applyFinalEffectiveToolPolicy({
    bundledTools: params.mcpTools,
    config: params.context.cfg,
    conversationCapabilityProfile: resolveConversationCapabilityProfile({
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
    }),
    warn: logWarn,
  });
}

async function resolveReadOnlyToolsEffectiveInventory(
  context: TrustedToolsEffectiveContext,
): Promise<EffectiveToolInventoryResult> {
  const baseResolution = await resolveCachedBaseToolsEffective({
    sessionKey: context.sessionKey,
    context,
  });
  const base = baseResolution.inventory;
  const harness = context.agentHarnessId
    ? getRegisteredAgentHarness(context.agentHarnessId)?.harness
    : undefined;
  if (harness?.loadMcpToolCatalog) {
    const mcpConfig = resolveCachedSessionMcpConfigSummary({
      context,
      workspaceDir: context.workspaceDir,
    });
    if (mcpConfig.serverNames.length === 0) {
      return base;
    }
    try {
      const catalog = await harness.loadMcpToolCatalog({
        config: context.cfg,
        agentId: context.agentId,
        sessionId: context.sessionId,
        sessionKey: context.sessionKey,
        workspaceDir: context.workspaceDir,
        mcpServerNames: mcpConfig.serverNames,
        toolOverrides: context.toolOverrides,
      });
      if (catalog) {
        return await projectMcpCatalog({
          base,
          catalog,
          context,
          runtimeModelContext: baseResolution.runtimeModelContext,
          workspaceDir: context.workspaceDir,
        });
      }
    } catch (error) {
      logWarn(
        `tools-effective: ${context.agentHarnessId} MCP catalog failed for session ${context.sessionKey}: ${String(error)}`,
      );
    }
    // A native owner has a distinct MCP runtime. Never substitute an in-process
    // catalog under the same OpenClaw session identity when its catalog is unavailable.
    return maybeAppendMcpNotice(base, mcpConfig.serverNames, "not-connected");
  }
  // UI panel loads call `tools.effective`, so this path must not create MCP
  // runtimes, connect transports, or issue tools/list. It only projects an
  // already-warm core session catalog. Native harnesses opt into their own
  // catalog read above because they own a separate per-thread runtime.
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
  const runtimeModelContext =
    runtime.workspaceDir === context.workspaceDir
      ? baseResolution.runtimeModelContext
      : await resolveEffectiveToolInventoryRuntimeModelContextAsync({
          cfg: context.cfg,
          agentId: context.agentId,
          agentDir: resolveAgentDir(context.cfg, context.agentId),
          workspaceDir: runtime.workspaceDir,
          modelProvider: context.modelProvider,
          modelId: context.modelId,
        });
  return await projectMcpCatalog({
    base,
    catalog,
    context,
    runtimeModelContext,
    workspaceDir: runtime.workspaceDir,
  });
}

async function projectMcpCatalog(params: {
  base: EffectiveToolInventoryResult;
  catalog: Parameters<typeof buildBundleMcpToolsFromCatalog>[0]["catalog"];
  context: TrustedToolsEffectiveContext;
  runtimeModelContext: RuntimeModelContext;
  workspaceDir: string;
}): Promise<EffectiveToolInventoryResult> {
  const projectedMcpTools = buildBundleMcpToolsFromCatalog({
    catalog: params.catalog,
    reservedToolNames: params.base.groups.flatMap((group) => group.tools.map((tool) => tool.id)),
    includeSessionDenied: true,
  });
  const filteredMcpTools = filterMcpTools({
    context: params.context,
    mcpTools: projectedMcpTools,
  });
  const mcpInventory = buildRuntimeCompatibleMcpToolInventory({
    tools: filteredMcpTools,
    cfg: params.context.cfg,
    workspaceDir: params.workspaceDir,
    modelProvider: params.context.modelProvider,
    modelId: params.context.modelId,
    modelApi: params.runtimeModelContext.modelApi,
    runtimeModel: params.runtimeModelContext.runtimeModel,
  });
  return appendMcpInventoryGroups({ base: params.base, mcpInventory });
}

function resolveTrustedToolsEffectiveContext(params: {
  sessionKey: string;
  requestedAgentId?: string;
  respond: RespondFn;
}) {
  // The effective tools request is read-only but security-sensitive. Derive
  // routing/account/model context from the persisted session, not client params.
  const loaded = loadGatewaySessionEntryReadOnly(
    params.sessionKey,
    params.requestedAgentId ? { agentId: params.requestedAgentId } : undefined,
  );
  if (!loaded.entry) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session key "${params.sessionKey}"`),
    );
    return null;
  }

  const canonicalKey = loaded.canonicalKey ?? params.sessionKey;
  const sessionAgentId = resolveSessionAgentId({
    sessionKey: canonicalKey,
    config: loaded.cfg,
    ...(params.requestedAgentId ? { agentId: params.requestedAgentId } : {}),
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
  const origin = sessionDeliveryOrigin(loaded.entry);
  const resolvedModel = resolveSessionModelRef(loaded.cfg, loaded.entry, sessionAgentId);
  const workspaceDir =
    normalizeOptionalString(loaded.entry.spawnedWorkspaceDir) ??
    resolveAgentWorkspaceDir(loaded.cfg, sessionAgentId);
  const runtimeConfigCacheKey = resolveRuntimeConfigCacheKey(loaded.cfg);
  const pluginRegistryVersion = getActivePluginRegistryVersion();
  const channelRegistryVersion = getActivePluginChannelRegistryVersion();
  const nodePluginToolsVersion = getConnectedNodePluginToolsVersion();
  return {
    cfg: loaded.cfg,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    sessionId: loaded.entry.sessionId,
    workspaceDir,
    runtimeConfigCacheKey,
    pluginRegistryVersion,
    channelRegistryVersion,
    nodePluginToolsVersion,
    modelProvider: resolvedModel.provider,
    modelId: resolvedModel.model,
    messageProvider: delivery?.channel ?? origin?.provider,
    accountId: delivery?.accountId ?? origin?.accountId,
    currentChannelId: delivery?.to,
    currentThreadTs:
      delivery?.threadId != null
        ? stringifyRouteThreadId(delivery.threadId)
        : origin?.threadId != null
          ? stringifyRouteThreadId(origin.threadId)
          : undefined,
    groupId: loaded.entry.groupId,
    groupChannel: loaded.entry.groupChannel,
    groupSpace: loaded.entry.space,
    spawnedBy: normalizeOptionalString(loaded.entry.spawnedBy),
    agentHarnessId: normalizeOptionalString(loaded.entry.agentHarnessId),
    toolOverrides: loaded.entry.toolOverrides,
    replyToMode: resolveReplyToMode(
      loaded.cfg,
      delivery?.channel ?? origin?.provider,
      delivery?.accountId ?? origin?.accountId,
      loaded.entry.chatType ?? origin?.chatType,
    ),
  };
}

async function handleToolsEffectiveRequest(params: {
  rawParams: unknown;
  respond: RespondFn;
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"];
}) {
  if (
    !assertValidParams(
      params.rawParams,
      validateToolsEffectiveParams,
      "tools.effective",
      params.respond,
    )
  ) {
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
  const sessionOwner = resolveRequestedSessionAgentId(
    cfg,
    params.rawParams.sessionKey,
    requestedAgentId,
  );
  if (!sessionOwner.ok) {
    params.respond(false, undefined, sessionOwner.error);
    return;
  }
  const trustedContext = resolveTrustedToolsEffectiveContext({
    sessionKey: params.rawParams.sessionKey,
    requestedAgentId: sessionOwner.agentId,
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
