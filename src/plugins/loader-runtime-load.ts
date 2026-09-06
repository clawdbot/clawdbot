import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentToolResultMiddlewareRuntimeIds } from "./agent-tool-result-middleware.js";
import { createUnavailableRuntime } from "./api-builder.js";
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
  matchesScopedPluginOrDreamingSidecar,
  maybeThrowOnPluginLoadError,
  resolveAuthorizedDreamingSidecar,
} from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";
import { createPluginIdScopeSet, normalizePluginIdScope } from "./plugin-scope.js";
import { projectPluginContributions } from "./registry-contributions.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import { createPluginRegistry, type PluginRegistry } from "./registry.js";
import { getActivePluginRegistry } from "./runtime.js";
import type { PluginRuntime } from "./runtime/types.js";
import { hasKind } from "./slots.js";

const registryInputs = new WeakMap<PluginRegistry, Map<string, string>>();

type PluginModuleLoaderOverrides = Pick<
  Parameters<typeof createPluginModuleLoader>[0],
  "tryNative" | "loaderFilename" | "installNativeSdkResolver"
>;
type InternalPluginLoadOverrides = {
  moduleLoader: PluginModuleLoaderOverrides;
  runtime: Pick<PluginRuntime, "config">;
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

export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  return loadOpenClawPluginsInternal(options);
}

/** Internal entry for host-owned snapshots that need a narrow registration runtime. */
export function loadOpenClawPluginsWithInternalOverrides(
  options: PluginLoadOptions & { cache: false },
  overrides: InternalPluginLoadOverrides,
): PluginRegistry {
  return loadOpenClawPluginsInternal(options, overrides);
}

function loadOpenClawPluginsInternal(
  options: PluginLoadOptions,
  overrides?: InternalPluginLoadOverrides,
): PluginRegistry {
  const requestedOnlyPluginIds = normalizePluginIdScope(options.onlyPluginIds);
  const requestedOnlyPluginIdSet = createPluginIdScopeSet(requestedOnlyPluginIds);
  if (requestedOnlyPluginIdSet && requestedOnlyPluginIdSet.size === 0) {
    const emptyRegistry = createEmptyPluginRegistry();
    if (options.mode !== "cli-metadata" && options.activate !== false) {
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
  const logger = options.logger ?? createSubsystemLogger("plugins");
  const validateOnly = options.mode === "validate";
  const onlyPluginIdSet = createPluginIdScopeSet(context.onlyPluginIds);
  const cacheEnabled = !options.previousRegistry && isPluginRegistryCacheEnabled(options);
  if (cacheEnabled) {
    const cached = context.cacheState.get(context.cacheKey);
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

  context.cacheState.beginLoad(context.cacheKey);
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
    const runtime =
      options.mode === "cli-metadata"
        ? createUnavailableRuntime("cli-metadata")
        : overrides?.runtime
          ? // The registry wraps this discovery-only base with scoped lazy capabilities.
            (overrides.runtime as unknown as PluginRuntime)
          : createLazyPluginRuntime({
              devSourceRoot: context.devSourceRoot,
              pluginSdkResolution: options.pluginSdkResolution,
              runtimeOptions: {
                ...options.runtimeOptions,
                subagent: options.runtimeOptions?.subagent ?? borrowedSubagent,
                nodes: options.runtimeOptions?.nodes ?? borrowedNodes,
              },
              loadPluginModule,
            });
    registryBuilder = createPluginRegistry({
      logger,
      runtime,
      allowProcessHomeSessionCatalogs: options.allowProcessHomeSessionCatalogs ?? true,
      coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
      ...(options.coreGatewayMethodNames !== undefined && {
        coreGatewayMethodNames: options.coreGatewayMethodNames,
      }),
      ...(options.hostServices !== undefined && { hostServices: options.hostServices }),
      activateGlobalSideEffects: options.runtimeSideEffects ?? context.shouldActivate,
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
    const replacedIds = new Set(options.replacePluginIds ?? []);
    const memorySlot = context.normalized.slots.memory;
    const dreamingSidecar = resolveAuthorizedDreamingSidecar({
      cfg: context.cfg,
      normalized: context.normalized,
      activationSource: context.activationSource,
      manifestRegistry,
      memorySlot,
    });
    const inputs = new Map<string, string>();
    const retained = new Map<string, PluginRegistry["plugins"][number]>();
    for (const candidate of orderedCandidates) {
      const manifest = manifestBySource.get(candidate.source);
      if (
        !manifest ||
        inputs.has(manifest.id) ||
        !matchesScopedPluginOrDreamingSidecar({
          onlyPluginIdSet,
          pluginId: manifest.id,
          sidecar: dreamingSidecar,
        })
      ) {
        continue;
      }
      const activation = resolveEffectivePluginActivationState({
        id: manifest.id,
        origin: candidate.origin,
        channelIds: manifest.channels,
        config: context.normalized,
        rootConfig: context.cfg,
        enabledByDefault: isPluginEnabledByDefaultForPlatform(manifest),
        activationSource: context.activationSource,
      });
      // Capture policy inputs at load time; later snapshots cannot preserve a now-denied instance.
      const input = JSON.stringify([
        candidate.source,
        candidate.origin,
        manifest,
        activation,
        context.normalized.entries[normalizePluginPolicyId(manifest.id)],
        hasKind(manifest.kind, "memory") ? memorySlot : undefined,
        manifest.id === dreamingSidecar?.engineId ? dreamingSidecar : undefined,
        context.artifactPreference,
        options.runtimeSideEffects ?? context.shouldActivate,
        context.channelPluginLoadIntent,
        validateOnly,
        options.toolDiscovery === true,
        options.mode,
      ]);
      inputs.set(manifest.id, input);
      const previous = options.previousRegistry?.plugins.find(
        (record) => record.id === manifest.id,
      );
      if (
        previous &&
        !replacedIds.has(manifest.id) &&
        registryInputs.get(options.previousRegistry!)?.get(manifest.id) === input
      ) {
        retained.set(manifest.id, previous);
        projectPluginContributions(options.previousRegistry!, previous, registry);
      }
    }
    if (options.previousRegistry) {
      registry.diagnostics.push(
        ...options.previousRegistry.diagnostics.filter(
          (entry) => entry.pluginId && retained.has(entry.pluginId),
        ),
      );
    }
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
      if (retained.has(record.id) || options.mode === "cli-metadata") {
        continue;
      }
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
    const state: PluginLoadLoopState = {
      seenIds: new Map(),
      selectedMemoryPluginId: null,
      memorySlotMatched: false,
      pluginLoadAttemptCount: 0,
    };
    const pluginLoadStartMs = performance.now();
    for (const candidate of orderedCandidates) {
      const manifestRecord = manifestBySource.get(candidate.source);
      if (!manifestRecord) {
        continue;
      }
      const previous = retained.get(manifestRecord.id);
      if (previous && !state.seenIds.has(manifestRecord.id)) {
        registry.plugins.push(previous);
        state.seenIds.set(previous.id, previous.origin);
        if (previous.memorySlotSelected) {
          state.selectedMemoryPluginId = previous.id;
          state.memorySlotMatched = true;
        }
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
    if (
      options.mode !== "cli-metadata" &&
      !onlyPluginIdSet &&
      typeof memorySlot === "string" &&
      !state.memorySlotMatched
    ) {
      registry.diagnostics.push({
        level: "warn",
        message: `memory slot plugin not found or not marked as memory: ${memorySlot}`,
      });
    }
    if (options.mode !== "cli-metadata") {
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
    }
    maybeThrowOnPluginLoadError(registry, options.throwOnLoadError);
    if (context.shouldActivate && options.mode !== "validate") {
      const failedPlugins = registry.plugins.filter((plugin) => plugin.failedAt != null);
      if (failedPlugins.length > 0) {
        logger.warn(
          `[plugins] ${failedPlugins.length} plugin(s) failed to initialize (${formatPluginFailureSummary(
            failedPlugins,
          )}). Run 'openclaw plugins inspect <id> --runtime --json' for runtime diagnostics, 'openclaw plugins list' for registry state, and 'openclaw plugins reload <id>' after fixing plugin code or load paths.`,
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
      context.cacheState.set(context.cacheKey, registry);
    }
    registryInputs.set(registry, inputs);
    return registry;
  } catch (error) {
    // Registration failures discard only an inactive builder. Activation is failure-atomic, and
    // any later cache failure must not strip the registry already serving runtime consumers.
    if (context.shouldActivate && registryBuilder?.registry !== getActivePluginRegistry()) {
      for (const plugin of registryBuilder?.registry.plugins.toReversed() ?? []) {
        if (plugin.status === "loaded" && !options.previousRegistry?.plugins.includes(plugin)) {
          registryBuilder?.rollbackPluginGlobalSideEffects(plugin.id, plugin);
        }
      }
    }
    throw error;
  } finally {
    context.cacheState.finishLoad(context.cacheKey);
  }
}
