// Runtime bridge for invoking provider hooks supplied by plugins.
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getLoadedRuntimePluginRegistry,
  registryContainsRuntimePluginIds,
} from "./active-runtime-registry.js";
import {
  PluginLruCache,
  resolveConfigScopedRuntimeCacheValue,
  type ConfigScopedRuntimeCache,
} from "./plugin-cache-primitives.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import {
  resolveModelCatalogScope,
  resolveProviderConfigApiOwnerHint,
} from "./provider-config-owner.js";
import { matchesProviderPluginRef } from "./provider-registry-shared.js";
import { isPluginProvidersLoadInFlight, resolvePluginProvidersCore } from "./providers.runtime.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  getActivePluginRegistryWorkspaceDirFromState,
  getPluginRegistryState,
} from "./runtime-state.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-scope.js";
import type {
  ProviderPlugin,
  ProviderExtraParamsForTransportContext,
  ProviderPrepareExtraParamsContext,
  ProviderResolveAuthProfileIdContext,
  ProviderFollowupFallbackRouteContext,
  ProviderFollowupFallbackRouteResult,
  ProviderWrapStreamFnContext,
} from "./types.js";

const providerRuntimePluginCache: ConfigScopedRuntimeCache<ProviderPlugin | null> = new WeakMap();
const defaultProviderRuntimePluginCache = new PluginLruCache<ProviderPlugin | null>(128);

type ProviderRuntimePluginLookupParams = {
  provider: string;
  providerOwner?: string;
  modelId?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  applyAutoEnable?: boolean;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
};

export type ProviderRuntimePluginHandle = ProviderRuntimePluginLookupParams & {
  plugin?: ProviderPlugin;
};

const MODEL_PROVIDER_RUNTIME_PLUGIN_HANDLE_SYMBOL = Symbol.for(
  "openclaw.modelProviderRuntimePluginHandle",
);

type ModelWithProviderRuntimePluginHandle = {
  [MODEL_PROVIDER_RUNTIME_PLUGIN_HANDLE_SYMBOL]?: ProviderRuntimePluginHandle;
};

type ProviderRuntimePluginHandleParams = ProviderRuntimePluginLookupParams & {
  runtimeHandle?: ProviderRuntimePluginHandle;
};

/** Carries one attempt's prepared provider plugin through the model transport boundary. */
export function attachModelProviderRuntimePluginHandle<TModel extends object>(
  model: TModel,
  runtimeHandle: ProviderRuntimePluginHandle,
): TModel {
  const next = { ...model } as TModel & ModelWithProviderRuntimePluginHandle;
  next[MODEL_PROVIDER_RUNTIME_PLUGIN_HANDLE_SYMBOL] = runtimeHandle;
  return next;
}

/** Reads the provider plugin handle attached to a prepared attempt model. */
export function getModelProviderRuntimePluginHandle(
  model: object | undefined,
): ProviderRuntimePluginHandle | undefined {
  return model
    ? (model as ModelWithProviderRuntimePluginHandle)[MODEL_PROVIDER_RUNTIME_PLUGIN_HANDLE_SYMBOL]
    : undefined;
}

function resolveProviderRuntimePluginCacheKey(
  params: ProviderRuntimePluginLookupParams,
  registryState = getPluginRegistryState(),
): string {
  return JSON.stringify({
    providerScope: [params.provider, params.providerOwner].map(normalizeLowercaseStringOrEmpty),
    modelId: resolveProviderRuntimeLookupModelId(params) ?? null,
    pluginControlPlane: resolvePluginControlPlaneFingerprint({
      config: params.config,
      env: params.env,
      workspaceDir: params.workspaceDir,
    }),
    plugins: params.config?.plugins,
    models: params.config?.models?.providers,
    workspaceDir: params.workspaceDir ?? "",
    applyAutoEnable: params.applyAutoEnable ?? null,
    pluginMetadata:
      params.pluginMetadataSnapshot?.manifestRegistry.plugins
        .map((plugin) => plugin.id)
        .join(",") ?? null,
    pluginRegistryKey: registryState?.key ?? null,
    pluginRegistryVersion: registryState?.activeVersion ?? null,
  });
}

function matchesProviderLiteralId(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(providerId);
  return Boolean(normalized) && normalizeLowercaseStringOrEmpty(provider.id) === normalized;
}

function resolveProviderRuntimeLookupModelId(
  params: ProviderRuntimePluginLookupParams & { context?: { modelId?: unknown } },
): string | undefined {
  return normalizeOptionalString(
    params.modelId ??
      (typeof params.context?.modelId === "string" ? params.context.modelId : undefined),
  );
}

function resolveProviderRuntimeLookupScope(
  params: ProviderRuntimePluginLookupParams,
  ownerRefs: readonly string[],
): {
  providerRefs: string[];
  modelRefs?: string[];
} {
  const providerRefs = [params.provider, ...ownerRefs];
  const modelId = resolveProviderRuntimeLookupModelId(params);
  if (!modelId) {
    return { providerRefs };
  }
  return {
    providerRefs,
    modelRefs: resolveModelCatalogScope({
      cfg: params.config,
      provider: params.provider,
      model: modelId,
    }).modelRefs,
  };
}

function findProviderRuntimePluginInLoadedRegistries(params: {
  lookup: ProviderRuntimePluginLookupParams;
  ownerRefs: readonly string[];
}): ProviderPlugin | undefined {
  const generationRegistry = getPluginRuntimeGenerationRegistry();
  if (generationRegistry) {
    return findProviderRuntimePluginInRegistry({
      registry: generationRegistry,
      provider: params.lookup.provider,
      ownerRefs: params.ownerRefs,
    });
  }
  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const scopedPlugin = scopedRegistry
    ? findProviderRuntimePluginInRegistry({
        registry: scopedRegistry,
        provider: params.lookup.provider,
        ownerRefs: params.ownerRefs,
      })
    : undefined;
  if (scopedPlugin) {
    return scopedPlugin;
  }
  const activeRegistry = getLoadedRuntimePluginRegistry({
    env: params.lookup.env,
    workspaceDir: params.lookup.workspaceDir,
  });
  const activePlugin = activeRegistry
    ? findProviderRuntimePluginInRegistry({
        registry: activeRegistry,
        provider: params.lookup.provider,
        ownerRefs: params.ownerRefs,
      })
    : undefined;
  if (activePlugin) {
    return activePlugin;
  }
  return undefined;
}

function findProviderRuntimePluginInRegistry(params: {
  registry: PluginRegistry;
  provider: string;
  ownerRefs: readonly string[];
}): ProviderPlugin | undefined {
  return listProviderRuntimePluginsInRegistry(params.registry).find((plugin) => {
    if (params.ownerRefs.length > 0) {
      return (
        matchesProviderLiteralId(plugin, params.provider) ||
        params.ownerRefs.some((ownerRef) => matchesProviderPluginRef(plugin, ownerRef))
      );
    }
    return matchesProviderPluginRef(plugin, params.provider);
  });
}

function listProviderRuntimePluginsInRegistry(
  registry: PluginRegistry,
): Array<ProviderPlugin & { pluginId: string }> {
  return registry.providers.map((entry) =>
    Object.assign({}, entry.provider, { pluginId: entry.pluginId }),
  );
}

function hasConfiguredModelProvider(params: {
  provider: string;
  config?: OpenClawConfig;
}): boolean {
  return (
    findNormalizedProviderValue(params.config?.models?.providers, params.provider) !== undefined
  );
}

export function resolveLoadedProviderPluginsForHooks(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  providerRefs?: readonly string[];
  modelRefs?: readonly string[];
  applyAutoEnable?: boolean;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
}): ProviderPlugin[] | undefined {
  const filterRegistryPlugins = (registry: PluginRegistry) => {
    const onlyPluginIds = params.onlyPluginIds ? new Set(params.onlyPluginIds) : undefined;
    return listProviderRuntimePluginsInRegistry(registry).filter(
      (plugin) =>
        (!onlyPluginIds || onlyPluginIds.has(plugin.pluginId)) &&
        (!params.providerRefs?.length ||
          params.providerRefs.some((providerRef) => matchesProviderPluginRef(plugin, providerRef))),
    );
  };
  const generationRegistry = getPluginRuntimeGenerationRegistry();
  if (generationRegistry) {
    return filterRegistryPlugins(generationRegistry);
  }
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  // An empty generation is authoritative. Outside a generation, only a loaded
  // hit proves the registry serves this query; preparation may discover on a miss.
  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  for (const registry of [
    scopedRegistry,
    getLoadedRuntimePluginRegistry({ env, workspaceDir, requiredPluginIds: params.onlyPluginIds }),
  ]) {
    if (registry && registryContainsRuntimePluginIds(registry, params.onlyPluginIds)) {
      const plugins = filterRegistryPlugins(registry);
      if (plugins.length > 0) {
        return plugins;
      }
    }
  }
  return undefined;
}

export function resolveProviderPluginsForHooks(
  params: Parameters<typeof resolveLoadedProviderPluginsForHooks>[0],
): ProviderPlugin[] {
  const loaded = resolveLoadedProviderPluginsForHooks(params);
  if (loaded) {
    return loaded;
  }
  return resolvePluginProvidersCore({
    ...params,
    workspaceDir: params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState(),
    env: params.env ?? process.env,
    activate: false,
    applyAutoEnable: params.applyAutoEnable,
    skipIfLoadInFlight: true,
  });
}

export function resolveProviderRuntimePlugin(
  params: ProviderRuntimePluginLookupParams,
): ProviderPlugin | undefined {
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  const env = params.env ?? process.env;
  const lookup = { ...params, workspaceDir, env };
  const apiOwnerHint = resolveProviderConfigApiOwnerHint({
    provider: params.provider,
    config: params.config,
  });
  const ownerRefs = [...new Set([params.providerOwner, apiOwnerHint].filter(Boolean))] as string[];
  const providerRefs = [params.provider, ...ownerRefs];
  const loadedPlugin = findProviderRuntimePluginInLoadedRegistries({
    lookup,
    ownerRefs,
  });
  if (loadedPlugin) {
    return loadedPlugin;
  }
  if (getPluginRuntimeGenerationRegistry()) {
    return undefined;
  }
  if (
    isPluginProvidersLoadInFlight({
      ...params,
      workspaceDir,
      env,
      providerRefs,
      activate: false,
      applyAutoEnable: params.applyAutoEnable,
    })
  ) {
    return undefined;
  }
  const cacheConfig = params.env && params.env !== process.env ? undefined : params.config;
  const registryState = getPluginRegistryState();
  const cacheKey = resolveProviderRuntimePluginCacheKey(lookup, registryState);
  const load = () => {
    const lookupScope = resolveProviderRuntimeLookupScope(params, ownerRefs);
    return (
      resolveProviderPluginsForHooks({
        config: params.config,
        workspaceDir,
        env,
        providerRefs: lookupScope.providerRefs,
        modelRefs: lookupScope.modelRefs,
        applyAutoEnable: params.applyAutoEnable,
        pluginMetadataSnapshot: params.pluginMetadataSnapshot,
      }).find((plugin) => {
        if (ownerRefs.length > 0) {
          return (
            matchesProviderLiteralId(plugin, params.provider) ||
            ownerRefs.some((ownerRef) => matchesProviderPluginRef(plugin, ownerRef))
          );
        }
        return matchesProviderPluginRef(plugin, params.provider);
      }) ?? null
    );
  };
  const plugin = cacheConfig
    ? resolveConfigScopedRuntimeCacheValue({
        cache: providerRuntimePluginCache,
        config: cacheConfig,
        key: cacheKey,
        load,
      })
    : !registryState?.key
      ? load()
      : (() => {
          const cached = defaultProviderRuntimePluginCache.get(cacheKey);
          if (cached !== undefined) {
            return cached;
          }
          const loaded = load();
          defaultProviderRuntimePluginCache.set(cacheKey, loaded);
          return loaded;
        })();
  return plugin ?? undefined;
}

export function resolveLoadedProviderRuntimePlugin(
  params: ProviderRuntimePluginLookupParams,
): ProviderPlugin | undefined {
  const apiOwnerHint = resolveProviderConfigApiOwnerHint({
    provider: params.provider,
    config: params.config,
  });
  const ownerRefs = [...new Set([params.providerOwner, apiOwnerHint].filter(Boolean))] as string[];
  return findProviderRuntimePluginInLoadedRegistries({
    lookup: params,
    ownerRefs,
  });
}

export function resolveProviderHookPlugin(params: {
  provider: string;
  modelId?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin | undefined {
  const runtimePlugin = resolveProviderRuntimePlugin(params);
  if (runtimePlugin) {
    return runtimePlugin;
  }
  if (hasConfiguredModelProvider(params)) {
    return undefined;
  }
  return resolveProviderPluginsForHooks({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  }).find((candidate) => matchesProviderPluginRef(candidate, params.provider));
}

export function resolveProviderRuntimePluginHandle(
  params: ProviderRuntimePluginLookupParams,
): ProviderRuntimePluginHandle {
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  const env = params.env;
  const runtimePlugin = resolveProviderRuntimePlugin({
    ...params,
    workspaceDir,
    env,
  });

  return {
    ...params,
    workspaceDir,
    env,
    plugin: runtimePlugin,
  };
}

export function ensureProviderRuntimePluginHandle(
  params: ProviderRuntimePluginHandleParams,
): ProviderRuntimePluginHandle {
  const modelId = resolveProviderRuntimeLookupModelId(params);
  if (
    !params.runtimeHandle ||
    (modelId && !params.runtimeHandle.plugin && params.runtimeHandle.modelId !== modelId)
  ) {
    return resolveProviderRuntimePluginHandle({
      provider: params.provider,
      modelId,
      config: params.config ?? params.runtimeHandle?.config,
      workspaceDir: params.workspaceDir ?? params.runtimeHandle?.workspaceDir,
      env: params.env ?? params.runtimeHandle?.env,
      applyAutoEnable: params.runtimeHandle?.applyAutoEnable,
      pluginMetadataSnapshot:
        params.pluginMetadataSnapshot ?? params.runtimeHandle?.pluginMetadataSnapshot,
    });
  }
  return params.runtimeHandle;
}

export function prepareProviderExtraParams(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderPrepareExtraParamsContext;
}) {
  return (
    ensureProviderRuntimePluginHandle(params).plugin?.prepareExtraParams?.(params.context) ??
    undefined
  );
}

export function resolveProviderExtraParamsForTransport(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderExtraParamsForTransportContext;
}) {
  return (
    ensureProviderRuntimePluginHandle(params).plugin?.extraParamsForTransport?.(params.context) ??
    undefined
  );
}

export function resolveProviderAuthProfileId(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderResolveAuthProfileIdContext;
}): string | undefined {
  const resolved = ensureProviderRuntimePluginHandle(params).plugin?.resolveAuthProfileId?.(
    params.context,
  );
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : undefined;
}

export function resolveProviderFollowupFallbackRoute(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderFollowupFallbackRouteContext;
}): ProviderFollowupFallbackRouteResult | undefined {
  return (
    ensureProviderRuntimePluginHandle(params).plugin?.followupFallbackRoute?.(params.context) ??
    undefined
  );
}

export function wrapProviderStreamFn(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderWrapStreamFnContext;
}) {
  return (
    ensureProviderRuntimePluginHandle(params).plugin?.wrapStreamFn?.(params.context) ?? undefined
  );
}

export function wrapProviderSimpleCompletionStreamFn(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderWrapStreamFnContext;
}) {
  return (
    ensureProviderRuntimePluginHandle(params).plugin?.wrapSimpleCompletionStreamFn?.(
      params.context,
    ) ?? undefined
  );
}
