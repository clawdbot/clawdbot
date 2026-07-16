import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import {
  getReusableCachedPluginRegistry,
  pluginLoaderCacheState,
  setCachedPluginRegistry,
} from "./loader-cache.js";
import { resolvePluginLoadDiscovery } from "./loader-discovery.js";
import {
  resolvePluginLoadCacheContext,
  resolveRuntimeSubagentMode,
} from "./loader-load-context.js";
import { createLazyPluginRuntime, createPluginModuleLoader } from "./loader-module-runtime.js";
import { warnAboutUntrackedLoadedPlugins } from "./loader-provenance.js";
import { formatPluginFailureSummary } from "./loader-records.js";
import {
  loadRuntimePluginCandidate,
  type PluginLoadLoopState,
} from "./loader-runtime-candidate.js";
import {
  activatePluginRegistry,
  clearActivatedPluginRuntimeState,
  createPluginLoaderLogger,
  maybeThrowOnPluginLoadError,
  resolveAuthorizedDreamingSidecar,
} from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import {
  restorePluginProcessGlobalState,
  snapshotPluginProcessGlobalState,
} from "./plugin-registration-transaction.js";
import { createPluginIdScopeSet, normalizePluginIdScope } from "./plugin-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRegistry, type PluginRegistry } from "./registry.js";

export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  const requestedOnlyPluginIds = normalizePluginIdScope(options.onlyPluginIds);
  const requestedOnlyPluginIdSet = createPluginIdScopeSet(requestedOnlyPluginIds);
  if (requestedOnlyPluginIdSet && requestedOnlyPluginIdSet.size === 0) {
    const emptyRegistry = createEmptyPluginRegistry();
    if (options.activate !== false) {
      clearActivatedPluginRuntimeState();
      const runtimeSubagentMode = resolveRuntimeSubagentMode(options.runtimeOptions);
      activatePluginRegistry(
        emptyRegistry,
        `empty-plugin-scope::${runtimeSubagentMode}::${options.workspaceDir ?? ""}`,
        runtimeSubagentMode,
        options.workspaceDir,
      );
    }
    return emptyRegistry;
  }

  const context = resolvePluginLoadCacheContext(options);
  const logger = options.logger ?? createPluginLoaderLogger();
  const validateOnly = options.mode === "validate";
  const onlyPluginIdSet = createPluginIdScopeSet(context.onlyPluginIds);
  const cacheEnabled = options.cache !== false && options.resolveRawConfigEnvVars !== true;
  if (cacheEnabled) {
    const cached = getReusableCachedPluginRegistry({
      cacheKey: context.cacheKey,
      onlyPluginIds: context.onlyPluginIds,
      runtimeSubagentMode: context.runtimeSubagentMode,
      options,
    });
    if (cached) {
      if (context.shouldActivate) {
        restorePluginProcessGlobalState(cached.state.processGlobalState);
        activatePluginRegistry(
          cached.state.registry,
          cached.cacheKey,
          cached.runtimeSubagentMode,
          options.workspaceDir,
        );
      }
      return cached.state.registry;
    }
  }

  pluginLoaderCacheState.beginLoad(context.cacheKey);
  try {
    // Snapshot loads must not wipe global state registered by the active plugin set.
    if (context.shouldActivate) {
      clearActivatedPluginRuntimeState();
    }
    // Module and runtime loading stay lazy for discovery-only or disabled-plugin paths.
    const loadPluginModule = createPluginModuleLoader({
      devSourceRoot: context.devSourceRoot,
      pluginSdkResolution: options.pluginSdkResolution,
    });
    const runtime = createLazyPluginRuntime({
      devSourceRoot: context.devSourceRoot,
      pluginSdkResolution: options.pluginSdkResolution,
      runtimeOptions: options.runtimeOptions,
      loadPluginModule,
    });
    const registryBuilder = createPluginRegistry({
      logger,
      runtime,
      coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
      ...(options.coreGatewayMethodNames !== undefined && {
        coreGatewayMethodNames: options.coreGatewayMethodNames,
      }),
      ...(options.hostServices !== undefined && { hostServices: options.hostServices }),
      activateGlobalSideEffects: context.shouldActivate,
    });
    const { registry } = registryBuilder;
    const { manifestRegistry, orderedCandidates, manifestByRoot, provenance } =
      resolvePluginLoadDiscovery({
        options,
        context,
        diagnostics: registry.diagnostics,
        logger,
        onlyPluginIdSet,
        emitWarning: context.shouldActivate,
        warningCacheKey: context.cacheKey,
        suppliedManifestRegistry: options.manifestRegistry,
      });
    const memorySlot = context.normalized.slots.memory;
    const state: PluginLoadLoopState = {
      seenIds: new Map(),
      selectedMemoryPluginId: null,
      memorySlotMatched: false,
      pluginLoadAttemptCount: 0,
    };
    const dreamingSidecar = resolveAuthorizedDreamingSidecar({
      cfg: context.cfg,
      normalized: context.normalized,
      activationSource: context.activationSource,
      manifestRegistry,
      memorySlot,
    });
    const pluginLoadStartMs = performance.now();
    for (const candidate of orderedCandidates) {
      const manifestRecord = manifestByRoot.get(candidate.rootDir);
      if (!manifestRecord) {
        continue;
      }
      loadRuntimePluginCandidate({
        candidate,
        manifestRecord,
        context,
        options,
        onlyPluginIdSet,
        dreamingSidecar,
        validateOnly,
        registryBuilder,
        loadPluginModule,
        logger,
        state,
      });
    }
    const pluginLoadElapsedMs = performance.now() - pluginLoadStartMs;
    if (state.pluginLoadAttemptCount > 0) {
      logger.debug?.(
        `[plugins] loaded ${registry.plugins.length} plugin(s) (${state.pluginLoadAttemptCount} attempted) in ${pluginLoadElapsedMs.toFixed(1)}ms`,
      );
    }
    // Scoped snapshots may omit the configured memory plugin intentionally.
    if (!onlyPluginIdSet && typeof memorySlot === "string" && !state.memorySlotMatched) {
      registry.diagnostics.push({
        level: "warn",
        message: `memory slot plugin not found or not marked as memory: ${memorySlot}`,
      });
    }
    warnAboutUntrackedLoadedPlugins({
      registry,
      provenance,
      allowlist: context.normalized.allow,
      emitWarning: context.shouldActivate,
      logger,
      env: context.env,
    });
    maybeThrowOnPluginLoadError(registry, options.throwOnLoadError);
    if (context.shouldActivate && options.mode !== "validate") {
      const failedPlugins = registry.plugins.filter((plugin) => plugin.failedAt != null);
      if (failedPlugins.length > 0) {
        logger.warn(
          `[plugins] ${failedPlugins.length} plugin(s) failed to initialize (${formatPluginFailureSummary(
            failedPlugins,
          )}). Run 'openclaw plugins inspect <id> --runtime --json' for runtime diagnostics, 'openclaw plugins list' for registry state, and restart the Gateway after plugin code or load-path changes.`,
        );
      }
    }
    if (cacheEnabled) {
      setCachedPluginRegistry(
        context.cacheKey,
        {
          registry,
          processGlobalState: snapshotPluginProcessGlobalState(),
        },
        context.onlyPluginIds,
      );
    }
    if (context.shouldActivate) {
      activatePluginRegistry(
        registry,
        context.cacheKey,
        context.runtimeSubagentMode,
        options.workspaceDir,
      );
    }
    return registry;
  } finally {
    pluginLoaderCacheState.finishLoad(context.cacheKey);
  }
}

export { clearActivatedPluginRuntimeState } from "./loader-shared.js";
