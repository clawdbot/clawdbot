import { normalizeAgentToolResultMiddlewareRuntimeIds } from "./agent-tool-result-middleware.js";
import {
  recordPluginInstallOwnerLookup,
  resolvePluginCandidateInstallOwner,
} from "./candidate-install-owner.js";
import { resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { isPluginRegistryCacheEnabled } from "./loader-cache.js";
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
  createPluginLoaderLogger,
  maybeThrowOnPluginLoadError,
  resolveAuthorizedDreamingSidecar,
} from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { createPluginIdScopeSet, normalizePluginIdScope } from "./plugin-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { pluginLoaderCacheState } from "./registry-lifecycle.js";
import { getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import { createPluginRegistry, type PluginRegistry } from "./registry.js";
import { getActivePluginRegistry } from "./runtime.js";
import type { PluginRuntime } from "./runtime/types.js";

type PluginModuleLoaderOverrides = Pick<
  Parameters<typeof createPluginModuleLoader>[0],
  "tryNative" | "loaderFilename" | "installNativeSdkResolver"
>;
export type InternalPluginLoadOverrides = {
  moduleLoader: PluginModuleLoaderOverrides;
  runtime: Pick<PluginRuntime, "config" | "modelAuth" | "modelConfig">;
};

function createDeferredGatewaySubagentRuntime(runtime: PluginRuntime): PluginRuntime["subagent"] {
  return {
    complete: (...args) => runtime.subagent.complete(...args),
    run: (...args) => runtime.subagent.run(...args),
    waitForRun: (...args) => runtime.subagent.waitForRun(...args),
    getSessionMessages: (...args) => runtime.subagent.getSessionMessages(...args),
    deleteSession: (...args) => runtime.subagent.deleteSession(...args),
  };
}

function createDeferredGatewayNodesRuntime(runtime: PluginRuntime): PluginRuntime["nodes"] {
  return {
    list: (...args) => runtime.nodes.list(...args),
    invoke: (...args) => runtime.nodes.invoke(...args),
    openDuplex: (...args) => runtime.nodes.openDuplex(...args),
  };
}

export type NativePluginLoadBindings = Pick<PluginRuntime, "modelAuth" | "modelConfig"> & {
  capabilityCatalogContext: NonNullable<PluginLoadOptions["capabilityCatalogContext"]>;
};

export function loadOpenClawPluginsCore(
  options: PluginLoadOptions,
  nativeBindings: NativePluginLoadBindings,
  overrides?: InternalPluginLoadOverrides,
): PluginRegistry {
  const requestedOnlyPluginIds = normalizePluginIdScope(options.onlyPluginIds);
  const requestedOnlyPluginIdSet = createPluginIdScopeSet(requestedOnlyPluginIds);
  if (requestedOnlyPluginIdSet && requestedOnlyPluginIdSet.size === 0) {
    const emptyRegistry = createEmptyPluginRegistry();
    if (options.activate !== false) {
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
  const cacheEnabled = isPluginRegistryCacheEnabled(options);
  if (cacheEnabled) {
    const cached = pluginLoaderCacheState.get(context.cacheKey);
    if (cached) {
      maybeThrowOnPluginLoadError(cached, options.throwOnLoadError);
      if (context.shouldActivate) {
        activatePluginRegistry(
          cached,
          context.cacheKey,
          context.runtimeSubagentMode,
          options.workspaceDir,
        );
      }
      return cached;
    }
  }

  pluginLoaderCacheState.beginLoad(context.cacheKey);
  let registryBuilder: ReturnType<typeof createPluginRegistry> | undefined;
  try {
    // Module and runtime loading stay lazy for discovery-only or disabled-plugin paths.
    const loadPluginModule = createPluginModuleLoader({
      devSourceRoot: context.devSourceRoot,
      pluginSdkResolution: options.pluginSdkResolution,
      ...overrides?.moduleLoader,
    });
    const activeRuntime =
      options.runtimeOptions?.allowGatewaySubagentBinding === true
        ? getActivePluginRegistry()
        : undefined;
    const activeGatewayRuntime = activeRuntime
      ? getPluginRegistryRuntime(activeRuntime)
      : undefined;
    const borrowedSubagent = activeGatewayRuntime
      ? createDeferredGatewaySubagentRuntime(activeGatewayRuntime)
      : undefined;
    const borrowedNodes = activeGatewayRuntime
      ? createDeferredGatewayNodesRuntime(activeGatewayRuntime)
      : undefined;
    const lazyRuntime = createLazyPluginRuntime({
      devSourceRoot: context.devSourceRoot,
      pluginSdkResolution: options.pluginSdkResolution,
      runtimeOptions: {
        ...options.runtimeOptions,
        // Defaults are immutable host facts; each runtime retains its existing mutable method view.
        modelAuth: options.runtimeOptions?.modelAuth ?? { ...nativeBindings.modelAuth },
        modelConfig: options.runtimeOptions?.modelConfig ?? { ...nativeBindings.modelConfig },
        subagent: options.runtimeOptions?.subagent ?? borrowedSubagent,
        nodes: options.runtimeOptions?.nodes ?? borrowedNodes,
      },
      loadPluginModule,
    });
    const runtime = overrides?.runtime
      ? // Restricted discovery must not initialize full host services.
        // SAFETY: bundled-capability-runtime uses this base only for uncached, non-activating registration.
        (overrides.runtime as PluginRuntime)
      : lazyRuntime;
    const capabilityCatalogContext =
      options.capabilityCatalogContext ??
      options.capabilityCatalog?.context ??
      nativeBindings.capabilityCatalogContext;
    registryBuilder = createPluginRegistry({
      logger,
      runtime,
      resolveCapabilityCatalogContext: () => capabilityCatalogContext,
      allowProcessHomeSessionCatalogs: options.allowProcessHomeSessionCatalogs ?? true,
      coreGatewayHandlers: options.coreGatewayHandlers,
      ...(options.coreGatewayMethodNames !== undefined && {
        coreGatewayMethodNames: options.coreGatewayMethodNames,
      }),
      ...(options.hostServices !== undefined && { hostServices: options.hostServices }),
      activateGlobalSideEffects: context.shouldActivate,
    });
    const { registry } = registryBuilder;
    const { manifestRegistry, orderedCandidates, manifestBySource, provenance } =
      resolvePluginLoadDiscovery({
        options,
        context,
        diagnostics: registry.diagnostics,
        logger,
        onlyPluginIdSet,
        emitWarning: context.shouldActivate,
        warningCacheKey: context.cacheKey,
      });
    const selectedMiddlewareOwnerManifests = new Map<
      string,
      (typeof manifestRegistry.plugins)[number]
    >();
    for (const candidate of orderedCandidates) {
      const record = manifestBySource.get(candidate.source);
      if (record && !selectedMiddlewareOwnerManifests.has(record.id)) {
        selectedMiddlewareOwnerManifests.set(record.id, record);
      }
    }
    for (const record of selectedMiddlewareOwnerManifests.values()) {
      const activation = resolveEffectivePluginActivationState({
        id: record.id,
        origin: record.origin,
        channelIds: record.channels,
        config: context.normalized,
        rootConfig: context.cfg,
        enabledByDefault: isPluginEnabledByDefaultForPlatform(record),
        activationSource: context.activationSource,
      });
      const runtimes = normalizeAgentToolResultMiddlewareRuntimeIds(
        record.contracts?.agentToolResultMiddleware,
      );
      if (
        runtimes.length > 0 &&
        (record.origin === "bundled" || (activation.enabled && activation.explicitlyEnabled))
      ) {
        registry.agentToolResultMiddlewareOwners.push({
          pluginId: record.id,
          runtimes,
          manifest: record,
        });
      }
    }
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
      const manifestRecord = manifestBySource.get(candidate.source);
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
    warnAboutUntrackedLoadedPlugins(
      recordPluginInstallOwnerLookup(
        {
          registry,
          provenance,
          allowlist: context.normalized.allow,
          emitWarning: context.shouldActivate,
          logger,
          env: context.env,
        },
        new Map(
          orderedCandidates.flatMap((candidate) => {
            const pluginId = manifestBySource.get(candidate.source)?.id;
            const installOwner = resolvePluginCandidateInstallOwner(candidate);
            return pluginId && installOwner ? [[pluginId, installOwner] as const] : [];
          }),
        ),
      ),
    );
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
    if (context.shouldActivate) {
      // Install the complete bundle before hook-runner initialization.
      activatePluginRegistry(
        registry,
        context.cacheKey,
        context.runtimeSubagentMode,
        options.workspaceDir,
      );
    }
    // Publish only complete registries: failed activation restores the prior runtime selection,
    // then the catch below can discard this builder without poisoning a reusable cache value.
    if (cacheEnabled) {
      pluginLoaderCacheState.set(context.cacheKey, registry);
    }
    return registry;
  } catch (error) {
    // Registration failures discard only an inactive builder. Activation is failure-atomic, and
    // any later cache failure must not strip the registry already serving runtime consumers.
    if (context.shouldActivate && registryBuilder?.registry !== getActivePluginRegistry()) {
      for (const plugin of registryBuilder?.registry.plugins.toReversed() ?? []) {
        if (plugin.status === "loaded") {
          registryBuilder?.rollbackPluginGlobalSideEffects(plugin.id);
        }
      }
    }
    throw error;
  } finally {
    pluginLoaderCacheState.finishLoad(context.cacheKey);
  }
}
