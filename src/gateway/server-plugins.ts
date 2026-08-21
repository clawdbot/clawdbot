// Gateway plugin runtime adapter.
// Loads plugin registries and builds fallback request context for non-WS paths.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { AgentWaitResult } from "../agents/run-wait.types.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import { allowsProcessHomeSessionScan } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import type { ChannelPluginLoadIntent } from "../plugins/loader-types.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { loadPluginLookUpTable, type PluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import { getPluginModuleLoaderStats } from "../plugins/plugin-module-loader-cache.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistryParams } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntimeLoaderLogger } from "../plugins/runtime/load-context.js";
import { resolvePluginSubagentCompletionRequester } from "../plugins/runtime/subagent-requester-context.js";
import type {
  CreatePluginRuntimeOptions,
  PluginRuntime,
  RuntimeGatewayRequestOptions,
} from "../plugins/runtime/types.js";
import type { PluginLogger, PluginOrigin } from "../plugins/types.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import { normalizeOperatorScopeList, type OperatorScope } from "./operator-scopes.js";
import type {
  GatewayContextResolver,
  GatewayRequestHandler,
  GatewayRequestOptions,
} from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  dispatchGatewayMethodInProcessRaw,
  getInProcessGatewayRequestContext,
} from "./server-plugin-in-process-dispatch.js";
import { resolvePluginSubagentToolsAlsoAllow } from "./server-plugin-runtime-client.js";
import {
  normalizePluginSubagentAllowedModelRef,
  normalizePluginSubagentRunRuntime,
  resolvePluginSubagentRequestedModelRef,
} from "./server-plugin-subagent-runtime.js";
import {
  hasInProcessGatewayContext,
  projectGatewayRuntimeNodes,
} from "./server-plugins-node-runtime.js";

export {
  dispatchGatewayMethodInProcess,
  dispatchGatewayMethodInProcessRaw,
  getInProcessGatewayRequestContext,
};
export type { GatewayMethodDispatchResponse } from "./server-plugin-in-process-dispatch.js";
export { hasInProcessGatewayContext } from "./server-plugins-node-runtime.js";

type PluginSubagentOverridePolicy = {
  allowModelOverride: boolean;

  allowAnyModel: boolean;
  hasConfiguredAllowlist: boolean;
  allowedModels: Set<string>;
};

type PluginSubagentOverridePolicies = Record<string, PluginSubagentOverridePolicy>;

function resolvePluginSubagentOverridePolicies(
  cfg: OpenClawConfig,
): PluginSubagentOverridePolicies {
  const normalized = normalizePluginsConfig(cfg.plugins);
  const policies: PluginSubagentOverridePolicies = {};
  for (const [pluginId, entry] of Object.entries(normalized.entries)) {
    const allowModelOverride = entry.subagent?.allowModelOverride === true;
    const hasConfiguredAllowlist = entry.subagent?.hasAllowedModelsConfig === true;
    const configuredAllowedModels = entry.subagent?.allowedModels ?? [];
    const allowedModels = new Set<string>();
    let allowAnyModel = false;
    for (const modelRef of configuredAllowedModels) {
      const normalizedModelRef = normalizePluginSubagentAllowedModelRef(modelRef);
      if (!normalizedModelRef) {
        continue;
      }
      if (normalizedModelRef === "*") {
        allowAnyModel = true;
        continue;
      }
      allowedModels.add(normalizedModelRef);
    }
    if (
      !allowModelOverride &&
      !hasConfiguredAllowlist &&
      allowedModels.size === 0 &&
      !allowAnyModel
    ) {
      continue;
    }
    policies[pluginId] = {
      allowModelOverride,
      allowAnyModel,
      hasConfiguredAllowlist,
      allowedModels,
    };
  }
  return policies;
}

function authorizeFallbackModelOverride(params: {
  policies: PluginSubagentOverridePolicies;
  pluginId?: string;
  provider?: string;
  model?: string;
}): { allowed: true } | { allowed: false; reason: string } {
  const pluginId = params.pluginId?.trim();
  if (!pluginId) {
    return {
      allowed: false,
      reason: "provider/model override requires plugin identity in fallback subagent runs.",
    };
  }
  const policy = params.policies[pluginId];
  if (!policy?.allowModelOverride) {
    return {
      allowed: false,
      reason:
        `plugin "${pluginId}" is not trusted for fallback provider/model override requests. ` +
        "See https://docs.openclaw.ai/plugins/sdk-runtime#api-runtime-subagent and search for: " +
        "plugins.entries.<id>.subagent.allowModelOverride",
    };
  }
  if (policy.allowAnyModel) {
    return { allowed: true };
  }
  if (policy.hasConfiguredAllowlist && policy.allowedModels.size === 0) {
    return {
      allowed: false,
      reason: `plugin "${pluginId}" configured subagent.allowedModels, but none of the entries normalized to a valid provider/model target.`,
    };
  }
  if (policy.allowedModels.size === 0) {
    return { allowed: true };
  }
  const requestedModelRef = resolvePluginSubagentRequestedModelRef(params);
  if (!requestedModelRef) {
    return {
      allowed: false,
      reason:
        "fallback provider/model overrides that use an allowlist must resolve to a canonical provider/model target.",
    };
  }
  if (policy.allowedModels.has(requestedModelRef)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `model override "${requestedModelRef}" is not allowlisted for plugin "${pluginId}".`,
  };
}

// ── Internal gateway dispatch for plugin runtime ────────────────────

function hasAdminScope(client: GatewayRequestOptions["client"] | undefined): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

function canClientUseModelOverride(client: GatewayRequestOptions["client"]): boolean {
  return hasAdminScope(client) || client?.internal?.allowModelOverride === true;
}

function canTrustedOfficialPluginRequestScopes(params: {
  pluginId?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
}): boolean {
  if (!params.pluginId) {
    return false;
  }
  if (params.pluginOrigin === "bundled" || params.pluginTrustedOfficialInstall === true) {
    return true;
  }
  const registry = getActivePluginRegistry();
  const record = registry?.plugins.find((entry) => entry.id === params.pluginId);
  return record?.origin === "bundled" || record?.trustedOfficialInstall === true;
}

function resolveRuntimeNodeInvokeSyntheticScopes(params: {
  pluginId?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
  requestedScopes?: OperatorScope[];
}): OperatorScope[] | undefined {
  // Requested scopes may replace caller scopes, so only bundled or trusted official plugins qualify.
  return params.requestedScopes && canTrustedOfficialPluginRequestScopes(params)
    ? params.requestedScopes
    : undefined;
}

export async function dispatchTrustedPluginGatewayMethod<T>(
  method: string,
  params: Record<string, unknown> = {},
  options?: RuntimeGatewayRequestOptions,
  resolveGatewayContext?: GatewayContextResolver,
): Promise<T> {
  const scope = getPluginRuntimeGatewayRequestScope();
  const pluginId = scope?.pluginId?.trim();
  if (!canTrustedOfficialPluginRequestScopes(scope ?? {})) {
    throw new Error("Gateway requests are only available to bundled or trusted official plugins.");
  }
  const syntheticScopes = normalizeOperatorScopeList(options?.scopes);
  return await dispatchGatewayMethodInProcess<T>(method, params, {
    forceSyntheticClient: true,
    pluginRuntimeOwnerId: pluginId,
    resolveGatewayContext,
    ...(syntheticScopes ? { syntheticScopes } : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

const PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT = 1_000;

export function createGatewaySubagentRuntime(
  resolveGatewayContext?: GatewayContextResolver,
  overridePolicies: PluginSubagentOverridePolicies = {},
): PluginRuntime["subagent"] {
  const getSessionMessages: PluginRuntime["subagent"]["getSessionMessages"] = async (params) => {
    const limit =
      params.limit == null || !Number.isFinite(params.limit)
        ? undefined
        : Math.min(
            PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT,
            Math.max(1, Math.floor(params.limit)),
          );
    const payload = await dispatchGatewayMethodInProcess<{ messages?: unknown[] }>(
      "sessions.get",
      {
        key: params.sessionKey,
        ...(limit != null && { limit }),
      },
      { resolveGatewayContext },
    );
    return { messages: Array.isArray(payload?.messages) ? payload.messages : [] };
  };

  const subagentRuntime: PluginRuntime["subagent"] = {
    async run(params) {
      if (params.disableTools === true && (params.toolsAlsoAllow?.length ?? 0) > 0) {
        throw new Error("Tool-free plugin subagent runs cannot request additive tools.");
      }
      const pluginSubagentRequester = resolvePluginSubagentCompletionRequester(
        params.completionDelivery,
      );
      const scope = getPluginRuntimeGatewayRequestScope();
      const pluginId =
        typeof scope?.pluginId === "string" && scope.pluginId.trim()
          ? scope.pluginId.trim()
          : undefined;
      const runtimePluginToolGrant = resolvePluginSubagentToolsAlsoAllow({
        pluginId,
        toolsAlsoAllow: params.toolsAlsoAllow,
      });
      const overrideRequested = Boolean(params.provider || params.model);
      const hasRequestScopeClient = Boolean(scope?.client);
      let allowOverride = hasRequestScopeClient && canClientUseModelOverride(scope?.client ?? null);
      let allowSyntheticModelOverride = false;
      if (overrideRequested && !allowOverride && !hasRequestScopeClient) {
        const fallbackAuth = authorizeFallbackModelOverride({
          policies: overridePolicies,
          pluginId: scope?.pluginId,
          provider: params.provider,
          model: params.model,
        });
        if (!fallbackAuth.allowed) {
          throw new Error(fallbackAuth.reason);
        }
        allowOverride = true;
        allowSyntheticModelOverride = true;
      }
      if (overrideRequested && !allowOverride) {
        throw new Error("provider/model override is not authorized for this plugin subagent run.");
      }
      const payload = await dispatchGatewayMethodInProcess<{
        runId?: string;
        sessionKey?: string;
        runtime?: unknown;
      }>(
        "agent",
        {
          sessionKey: params.sessionKey,
          message: params.message,
          deliver: params.deliver ?? false,
          ...(allowOverride && params.provider && { provider: params.provider }),
          ...(allowOverride && params.model && { model: params.model }),
          ...(params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt }),
          ...(params.lane && { lane: params.lane }),
          ...(params.cwd && { cwd: params.cwd }),
          ...(params.lightContext === true && { bootstrapContextMode: "lightweight" }),
          // The gateway `agent` schema requires `idempotencyKey: NonEmptyString`,
          // so fall back to a generated UUID when the caller omits it. Without
          // this, plugin subagent runs (for example memory-core dreaming
          // narrative) silently fail schema validation at the gateway.
          idempotencyKey: params.idempotencyKey || randomUUID(),
        },
        {
          allowSyntheticModelOverride,
          agentRunTracking: "plugin_subagent",
          ...(pluginId ? { pluginRuntimeOwnerId: pluginId } : {}),
          ...(pluginSubagentRequester ? { pluginSubagentRequester } : {}),
          ...(runtimePluginToolGrant ? { runtimePluginToolGrant } : {}),
          ...(params.disableTools === true ? { pluginSubagentToolsAllow: [] } : {}),
          resolveGatewayContext,
        },
      );
      const runId = payload?.runId;
      if (typeof runId !== "string" || !runId) {
        throw new Error("Gateway agent method returned an invalid runId.");
      }
      const sessionKey = payload?.sessionKey?.trim() || params.sessionKey;
      const runtime = normalizePluginSubagentRunRuntime(payload?.runtime);
      return { runId, sessionKey, ...(runtime ? { runtime } : {}) };
    },
    async waitForRun(params) {
      const payload = await dispatchGatewayMethodInProcess<
        Omit<AgentWaitResult, "status"> & { status?: string }
      >(
        "agent.wait",
        {
          runId: params.runId,
          ...(params.timeoutMs != null && { timeoutMs: params.timeoutMs }),
        },
        { resolveGatewayContext },
      );
      const { status: rawStatus, error, ...metadata } = payload;
      let status = rawStatus;
      if (status === "completed" || status === "succeeded") {
        status = "ok";
      } else if (status === "error" && error?.trim().toLowerCase() === "completed") {
        status = "ok";
      }
      if (status !== "ok" && status !== "error" && status !== "timeout" && status !== "pending") {
        throw new Error(`Gateway agent.wait returned unexpected status: ${rawStatus}`);
      }
      return {
        ...metadata,
        status,
        ...(status !== "ok" && error ? { error } : {}),
      };
    },
    getSessionMessages,
    async deleteSession(params) {
      const scope = getPluginRuntimeGatewayRequestScope();
      const pluginId =
        typeof scope?.pluginId === "string" && scope.pluginId.trim()
          ? scope.pluginId.trim()
          : undefined;
      const pluginOwnedCleanupOptions = pluginId
        ? {
            pluginRuntimeOwnerId: pluginId,
            ...(!hasAdminScope(scope?.client)
              ? {
                  forceSyntheticClient: true,
                  syntheticScopes: [ADMIN_SCOPE],
                }
              : {}),
          }
        : undefined;
      await dispatchGatewayMethodInProcess(
        "sessions.delete",
        {
          key: params.sessionKey,
          deleteTranscript: params.deleteTranscript ?? true,
        },
        { ...pluginOwnedCleanupOptions, resolveGatewayContext },
      );
    },
  };
  if (resolveGatewayContext) {
    bindGatewayContextResolver(subagentRuntime, resolveGatewayContext);
  }
  return subagentRuntime;
}

type GatewayRuntimeNodes = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"];

export function createGatewayNodesRuntime(
  resolveGatewayContext?: GatewayContextResolver,
): PluginRuntime["nodes"] {
  return {
    async list(params) {
      const context = getInProcessGatewayRequestContext(resolveGatewayContext);
      const payload = await dispatchGatewayMethodInProcess<{ nodes?: unknown[] }>(
        "node.list",
        {},
        {
          resolveGatewayContext: () => context,
        },
      );
      const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
      const filteredNodes =
        params?.connected === true
          ? nodes.filter(
              (node) =>
                typeof node === "object" &&
                (node as { connected?: unknown } | null)?.connected === true,
            )
          : nodes;
      return {
        nodes: projectGatewayRuntimeNodes(filteredNodes, context) as GatewayRuntimeNodes,
      };
    },
    async invoke(params) {
      const scope = getPluginRuntimeGatewayRequestScope();
      const pluginId =
        typeof scope?.pluginId === "string" && scope.pluginId.trim()
          ? scope.pluginId.trim()
          : undefined;
      const syntheticScopes = resolveRuntimeNodeInvokeSyntheticScopes({
        pluginId,
        pluginOrigin: scope?.pluginOrigin,
        pluginTrustedOfficialInstall: scope?.pluginTrustedOfficialInstall,
        requestedScopes: normalizeOperatorScopeList(params.scopes),
      });
      return await dispatchGatewayMethodInProcess<unknown>(
        "node.invoke",
        {
          nodeId: params.nodeId,
          command: params.command,
          ...(params.params !== undefined && { params: params.params }),
          timeoutMs: params.timeoutMs,
          idempotencyKey: params.idempotencyKey || randomUUID(),
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        },
        {
          ...(pluginId ? { pluginRuntimeOwnerId: pluginId } : {}),
          ...(syntheticScopes ? { forceSyntheticClient: true, syntheticScopes } : {}),
          ...(params.signal ? { signal: params.signal } : {}),
          resolveGatewayContext,
        },
      );
    },
  };
}

function createGatewayPluginRuntimeBindings(
  resolveGatewayContext: GatewayContextResolver,
  overridePolicies: PluginSubagentOverridePolicies,
): {
  runtime: Pick<PluginRuntime, "gateway" | "nodes" | "subagent"> &
    Pick<CreatePluginRuntimeOptions, "dispatchReplyFromConfig">;
  retire: () => void;
} {
  let active = true;
  const resolveBoundGatewayContext = () => (active ? resolveGatewayContext() : undefined);
  return {
    retire: () => {
      active = false;
    },
    runtime: {
      dispatchReplyFromConfig: async (params) => {
        const { dispatchReplyFromConfig } =
          await import("../auto-reply/reply/dispatch-from-config.js");
        const sessionWorkerPlacementContext = getInProcessGatewayRequestContext(
          resolveBoundGatewayContext,
        );
        return await withPluginRuntimeGatewayContextResolver(
          resolveBoundGatewayContext,
          async () =>
            await dispatchReplyFromConfig({
              ...params,
              ...(sessionWorkerPlacementContext ? { sessionWorkerPlacementContext } : {}),
            }),
        );
      },
      gateway: {
        isAvailable: async () => hasInProcessGatewayContext(resolveBoundGatewayContext),
        request: (method, params, options) =>
          dispatchTrustedPluginGatewayMethod(method, params, options, resolveBoundGatewayContext),
      },
      nodes: createGatewayNodesRuntime(resolveBoundGatewayContext),
      subagent: createGatewaySubagentRuntime(resolveBoundGatewayContext, overridePolicies),
    },
  };
}

// ── Plugin loading ──────────────────────────────────────────────────

function createGatewayPluginRegistrationLogger(params?: {
  suppressInfoLogs?: boolean;
}): PluginLogger {
  const logger = createPluginRuntimeLoaderLogger();
  if (params?.suppressInfoLogs !== true) {
    return logger;
  }
  return {
    ...logger,
    info: (_message: string) => undefined,
  };
}

export function loadGatewayPlugins(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  autoEnabledReasons?: Readonly<Record<string, string[]>>;
  workspaceDir?: string;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  coreGatewayMethodNames?: readonly string[];
  hostServices?: PluginRegistryParams["hostServices"];
  baseMethods: string[];
  pluginIds?: string[];
  pluginLookUpTable?: PluginLookUpTable;
  channelPluginLoadIntent?: ChannelPluginLoadIntent;
  suppressPluginInfoLogs?: boolean;
  startupTrace?: {
    detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
  };
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  resolveGatewayContext?: GatewayContextResolver;
}) {
  const started = performance.now();
  const allowProcessHomeSessionCatalogs = allowsProcessHomeSessionScan();
  const activationAutoEnabled =
    params.activationSourceConfig !== undefined && params.autoEnabledReasons === undefined
      ? applyPluginAutoEnable({
          config: params.activationSourceConfig,
          env: process.env,
          ...(params.pluginLookUpTable?.manifestRegistry
            ? { manifestRegistry: params.pluginLookUpTable.manifestRegistry }
            : {}),
          discovery: params.pluginLookUpTable?.discovery,
          ambientEnvTriggers: params.ambientEnvTriggers,
        })
      : undefined;
  const autoEnableMs = performance.now() - started;
  const autoEnabled =
    params.activationSourceConfig !== undefined
      ? {
          config: params.cfg,
          changes: activationAutoEnabled?.changes ?? [],
          autoEnabledReasons:
            params.autoEnabledReasons ?? activationAutoEnabled?.autoEnabledReasons ?? {},
        }
      : params.autoEnabledReasons !== undefined
        ? {
            config: params.cfg,
            changes: [],
            autoEnabledReasons: params.autoEnabledReasons,
          }
        : applyPluginAutoEnable({
            config: params.cfg,
            env: process.env,
            ...(params.pluginLookUpTable?.manifestRegistry
              ? { manifestRegistry: params.pluginLookUpTable.manifestRegistry }
              : {}),
            discovery: params.pluginLookUpTable?.discovery,
            ambientEnvTriggers: params.ambientEnvTriggers,
          });
  const resolvedConfigMs = performance.now() - started;
  const resolvedConfig = autoEnabled.config;
  const pluginIds = params.pluginIds ?? [
    ...(
      params.pluginLookUpTable ??
      loadPluginLookUpTable({
        config: resolvedConfig,
        activationSourceConfig: params.activationSourceConfig,
        workspaceDir: params.workspaceDir,
        env: process.env,
        ambientEnvTriggers: params.ambientEnvTriggers,
      })
    ).startup.pluginIds,
  ];
  const pluginIdsMs = performance.now() - started;
  if (pluginIds.length === 0) {
    const pluginRegistry = createEmptyPluginRegistry();
    activatePluginRegistry(pluginRegistry, null, "gateway-bindable", params.workspaceDir);
    params.startupTrace?.detail("plugins.gateway-load", [
      ["autoEnableMs", autoEnableMs],
      ["resolvedConfigMs", resolvedConfigMs],
      ["pluginIdsMs", pluginIdsMs],
      ["loadMs", 0],
      ["pluginIds", "0"],
      ["pluginCount", 0],
      ["gatewayHandlerCount", 0],
    ]);
    return {
      pluginRegistry,
      gatewayMethods: [...params.baseMethods],
      retireGatewayRuntimeBindings: () => {},
    };
  }
  const beforeLoad = performance.now();
  const loaderStatsBefore = getPluginModuleLoaderStats();
  const gatewayRuntimeBindings = createGatewayPluginRuntimeBindings(
    params.resolveGatewayContext ?? (() => undefined),
    resolvePluginSubagentOverridePolicies(resolvedConfig),
  );
  const pluginRegistry = loadAndActivateRootPluginRegistry({
    config: resolvedConfig,
    allowProcessHomeSessionCatalogs,
    activationSourceConfig: params.activationSourceConfig ?? params.cfg,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir: params.workspaceDir,
    onlyPluginIds: pluginIds,
    logger: createGatewayPluginRegistrationLogger({
      suppressInfoLogs: params.suppressPluginInfoLogs,
    }),
    ...(params.coreGatewayHandlers !== undefined && {
      coreGatewayHandlers: params.coreGatewayHandlers,
    }),
    ...(params.coreGatewayMethodNames !== undefined && {
      coreGatewayMethodNames: params.coreGatewayMethodNames,
    }),
    ...(params.hostServices !== undefined && {
      hostServices: params.hostServices,
    }),
    runtimeOptions: {
      allowGatewaySubagentBinding: true,
      ...gatewayRuntimeBindings.runtime,
    },
    channelPluginLoadIntent: params.channelPluginLoadIntent,
    preferBuiltPluginArtifacts: true,
    ...(params.startupTrace !== undefined && {
      startupTrace: params.startupTrace,
    }),
    ...(params.pluginLookUpTable
      ? {
          manifestRegistry: params.pluginLookUpTable.manifestRegistry,
          installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(
            params.pluginLookUpTable.index,
          ),
        }
      : {}),
  });
  const loadMs = performance.now() - beforeLoad;
  const loaderStatsAfter = getPluginModuleLoaderStats();
  const pluginMethods = Object.keys(pluginRegistry.gatewayHandlers);
  const gatewayMethods = uniqueStrings([...params.baseMethods, ...pluginMethods]);
  params.startupTrace?.detail("plugins.gateway-load", [
    ["autoEnableMs", autoEnableMs],
    ["resolvedConfigMs", resolvedConfigMs],
    ["pluginIdsMs", pluginIdsMs],
    ["loadMs", loadMs],
    ["pluginIds", String(pluginIds.length)],
    ["pluginCount", pluginIds.length],
    ["gatewayHandlers", String(pluginMethods.length)],
    ["gatewayHandlerCount", pluginMethods.length],
    ["loaderCallsCount", loaderStatsAfter.calls - loaderStatsBefore.calls],
    ["loaderNativeHitsCount", loaderStatsAfter.nativeHits - loaderStatsBefore.nativeHits],
    ["loaderNativeMissesCount", loaderStatsAfter.nativeMisses - loaderStatsBefore.nativeMisses],
    [
      "loaderSourceTransformForcedCount",
      loaderStatsAfter.sourceTransformForced - loaderStatsBefore.sourceTransformForced,
    ],
    [
      "loaderSourceTransformFallbacksCount",
      loaderStatsAfter.sourceTransformFallbacks - loaderStatsBefore.sourceTransformFallbacks,
    ],
    [
      "loaderTopSourceTransformTargets",
      loaderStatsAfter.topSourceTransformTargets
        .slice(0, 3)
        .map((entry) => `${entry.count}:${entry.target}`)
        .join(","),
    ],
  ]);
  return {
    pluginRegistry,
    gatewayMethods,
    retireGatewayRuntimeBindings: gatewayRuntimeBindings.retire,
  };
}
