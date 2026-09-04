// Gateway plugin runtime adapter.
// Loads plugin registries and builds fallback request context for non-WS paths.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import { allowsProcessHomeSessionScan } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import type { ChannelPluginLoadIntent } from "../plugins/loader-types.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { loadPluginLookUpTable, type PluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getPluginModuleLoaderStats } from "../plugins/plugin-module-loader-cache.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistryParams } from "../plugins/registry-types.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  buildPluginRuntimeLoadOptions,
  createPluginRuntimeLoaderLogger,
  setPluginRuntimeLoadContext,
  type PluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import type {
  CreatePluginRuntimeOptions,
  PluginRuntime,
  RuntimeGatewayRequestOptions,
} from "../plugins/runtime/types.js";
import type { PluginLogger, PluginOrigin } from "../plugins/types.js";
import { authorizeOperatorScopesForRequiredScope } from "./method-scopes.js";
import { normalizeOperatorScopeList, type OperatorScope } from "./operator-scopes.js";
import type { GatewayNodeInvokeStream } from "./server-methods/shared-types.js";
import type { GatewayContextResolver, GatewayRequestHandler } from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  dispatchGatewayMethodInProcessRaw,
  getInProcessGatewayRequestContext,
} from "./server-plugin-in-process-dispatch.js";
import {
  canTrustedOfficialPluginRequestScopes,
  createGatewaySubagentRuntime,
  resolvePluginSubagentOverridePolicies,
  type PluginSubagentOverridePolicies,
} from "./server-plugin-subagent-runtime.js";
import {
  createGatewayHooksRuntime,
  hasInProcessGatewayContext,
  openGatewayNodeDuplex,
  projectGatewayRuntimeNodes,
} from "./server-plugins-node-runtime.js";

export {
  dispatchGatewayMethodInProcess,
  dispatchGatewayMethodInProcessRaw,
  getInProcessGatewayRequestContext,
};
export type { GatewayMethodDispatchResponse } from "./server-plugin-in-process-dispatch.js";
export { runWithOperatorToolGatewayCleanupContext } from "./server-plugin-in-process-dispatch.js";
export { hasInProcessGatewayContext } from "./server-plugins-node-runtime.js";
export { createGatewaySubagentRuntime } from "./server-plugin-subagent-runtime.js";

// ── Internal gateway dispatch for plugin runtime ────────────────────

function resolveRuntimeNodeInvokeSyntheticScopes(params: {
  pluginId?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
  requestedScopes?: OperatorScope[];
}): OperatorScope[] | undefined {
  // Requested scopes may replace caller scopes, so only bundled or trusted official plugins qualify.
  return canTrustedOfficialPluginRequestScopes(params) ? params.requestedScopes : undefined;
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
    ...(!scope?.client ? { operatorRoleActor: { kind: "system" as const } } : {}),
    ...(syntheticScopes ? { syntheticScopes } : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

type GatewayRuntimeNodes = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"];

export function createGatewayNodesRuntime(
  resolveGatewayContext?: GatewayContextResolver,
  runtimeLifetime?: AbortSignal,
): PluginRuntime["nodes"] {
  const invokeNode = async (
    params: Parameters<PluginRuntime["nodes"]["invoke"]>[0],
    stream?: GatewayNodeInvokeStream,
    signal = params.signal,
  ) => {
    const scope = getPluginRuntimeGatewayRequestScope();
    const pluginId = scope?.pluginId?.trim() || undefined;
    const requestedScopes = resolveRuntimeNodeInvokeSyntheticScopes({
      pluginId,
      pluginOrigin: scope?.pluginOrigin,
      pluginTrustedOfficialInstall: scope?.pluginTrustedOfficialInstall,
      requestedScopes: normalizeOperatorScopeList(params.scopes),
    });
    const callerScopes =
      stream && scope?.client
        ? (normalizeOperatorScopeList(scope.client.connect.scopes) ?? [])
        : undefined;
    if (
      callerScopes &&
      requestedScopes?.some(
        (requestedScope) =>
          !authorizeOperatorScopesForRequiredScope(requestedScope, callerScopes).allowed,
      )
    ) {
      throw new Error("Requested node scopes exceed the authenticated Gateway caller's authority.");
    }
    // Forced synthetic stream clients must retain their authenticated caller's exact scopes.
    const syntheticScopes = requestedScopes ?? callerScopes;
    return dispatchGatewayMethodInProcess<unknown>(
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
        nodeInvokeApprovalSessionKey: params.sessionKey,
        ...(syntheticScopes ? { syntheticScopes } : {}),
        ...(stream || syntheticScopes ? { forceSyntheticClient: true } : {}),
        ...(stream ? { nodeInvokeStream: stream } : {}),
        ...(signal ? { signal } : {}),
        resolveGatewayContext,
      },
    );
  };

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
      return { nodes: projectGatewayRuntimeNodes(filteredNodes, context) as GatewayRuntimeNodes };
    },
    invoke: invokeNode,
    openDuplex: (params) =>
      openGatewayNodeDuplex({ params, invokeNode, resolveGatewayContext, runtimeLifetime }),
  };
}

function createGatewayPluginRuntimeBindings(
  resolveGatewayContext: GatewayContextResolver | undefined,
  overridePolicies: PluginSubagentOverridePolicies,
): {
  runtime: Pick<PluginRuntime, "gateway" | "hooks" | "nodes" | "subagent"> &
    Pick<CreatePluginRuntimeOptions, "dispatchReplyFromConfig">;
  retire: () => void;
} {
  let active = true;
  const lifetime = new AbortController();
  const resolveBoundGatewayContext = resolveGatewayContext
    ? () => (active ? resolveGatewayContext() : undefined)
    : undefined;
  return {
    retire: () => {
      lifetime.abort(new Error("Plugin Gateway runtime retired; duplex invocation cancelled."));
      active = false;
    },
    runtime: {
      dispatchReplyFromConfig: async (params) => {
        const { dispatchLowLevelChannelReplyFromConfig } =
          await import("../auto-reply/reply/dispatch-from-config.js");
        const sessionWorkerPlacementContext = getInProcessGatewayRequestContext(
          resolveBoundGatewayContext,
        );
        const run = async () =>
          await dispatchLowLevelChannelReplyFromConfig({
            ...params,
            ...(sessionWorkerPlacementContext ? { sessionWorkerPlacementContext } : {}),
          });
        return resolveBoundGatewayContext
          ? await withPluginRuntimeGatewayContextResolver(resolveBoundGatewayContext, run)
          : await run();
      },
      gateway: {
        isAvailable: async () => hasInProcessGatewayContext(resolveBoundGatewayContext),
        request: (method, params, options) =>
          dispatchTrustedPluginGatewayMethod(method, params, options, resolveBoundGatewayContext),
      },
      hooks: createGatewayHooksRuntime(resolveBoundGatewayContext),
      nodes: createGatewayNodesRuntime(resolveBoundGatewayContext, lifetime.signal),
      subagent: createGatewaySubagentRuntime(
        resolveBoundGatewayContext,
        overridePolicies,
        lifetime.signal,
      ),
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
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
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
    params.activationSourceConfig !== undefined || params.autoEnabledReasons !== undefined
      ? {
          config: params.cfg,
          autoEnabledReasons:
            params.autoEnabledReasons ?? activationAutoEnabled?.autoEnabledReasons ?? {},
        }
      : applyPluginAutoEnable({
          config: params.cfg,
          env: process.env,
          manifestRegistry: params.pluginLookUpTable?.manifestRegistry,
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
  const metadataSnapshot =
    params.pluginMetadataSnapshot ??
    getCurrentPluginMetadataSnapshot({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
    });
  const loaderMetadata = metadataSnapshot ?? params.pluginLookUpTable;
  const loadContext: PluginRuntimeLoadContext = {
    rawConfig: params.cfg,
    config: resolvedConfig,
    activationSourceConfig: params.activationSourceConfig ?? params.cfg,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir: params.workspaceDir,
    env: process.env,
    logger: createGatewayPluginRegistrationLogger({
      suppressInfoLogs: params.suppressPluginInfoLogs,
    }),
    preferBuiltPluginArtifacts: true,
    metadataSnapshot,
    ...(loaderMetadata
      ? {
          manifestRegistry: loaderMetadata.manifestRegistry,
          installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(loaderMetadata.index),
        }
      : {}),
  };
  if (pluginIds.length === 0) {
    const pluginRegistry = createEmptyPluginRegistry();
    // An empty startup registry still owns the artifact policy for later capability loads.
    setPluginRuntimeLoadContext(pluginRegistry, loadContext);
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
    params.resolveGatewayContext,
    resolvePluginSubagentOverridePolicies(resolvedConfig),
  );
  const pluginRegistry = loadAndActivateRootPluginRegistry({
    ...buildPluginRuntimeLoadOptions(loadContext),
    // Startup registration stays scoped; later capability loads use the complete bound generation.
    manifestRegistry: params.pluginLookUpTable?.manifestRegistry ?? loadContext.manifestRegistry,
    allowProcessHomeSessionCatalogs,
    onlyPluginIds: pluginIds,
    coreGatewayHandlers: params.coreGatewayHandlers,
    coreGatewayMethodNames: params.coreGatewayMethodNames,
    hostServices: params.hostServices,
    runtimeOptions: {
      allowGatewaySubagentBinding: true,
      ...gatewayRuntimeBindings.runtime,
    },
    channelPluginLoadIntent: params.channelPluginLoadIntent,
    startupTrace: params.startupTrace,
  });
  setPluginRuntimeLoadContext(pluginRegistry, loadContext);
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
