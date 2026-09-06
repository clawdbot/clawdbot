import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { attachModelProviderLocalServiceReconciler } from "../agents/provider-local-service-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getLoadedRuntimePluginRegistry,
  registryContainsRuntimePluginIds,
} from "./active-runtime-registry.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import {
  resolveModelCatalogScope,
  resolveProviderConfigApiOwnerHint,
} from "./provider-config-owner.js";
import { matchesProviderPluginRef } from "./provider-registry-shared.js";
import { isPluginProvidersLoadInFlight, resolvePluginProvidersCore } from "./providers.runtime.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-scope.js";
import type {
  ProviderPlugin,
  ProviderResolveAuthProfileIdContext,
  ProviderFollowupFallbackRouteContext,
  ProviderFollowupFallbackRouteResult,
  ProviderWrapStreamFnContext,
} from "./types.js";

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

type ProviderHookParams<TContext> = {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: TContext;
};

/** Carries one attempt's prepared provider plugin through the model transport boundary. */
export function attachModelProviderRuntimePluginHandle<TModel extends object>(
  model: TModel,
  runtimeHandle: ProviderRuntimePluginHandle,
): TModel {
  return Object.assign(
    attachModelProviderLocalServiceReconciler(model, runtimeHandle.plugin?.reconcileLocalService),
    { [MODEL_PROVIDER_RUNTIME_PLUGIN_HANDLE_SYMBOL]: runtimeHandle },
  );
}

/** Reads the provider plugin handle attached to a prepared attempt model. */
export function getModelProviderRuntimePluginHandle(
  model: object | undefined,
): ProviderRuntimePluginHandle | undefined {
  return model
    ? (model as ModelWithProviderRuntimePluginHandle)[MODEL_PROVIDER_RUNTIME_PLUGIN_HANDLE_SYMBOL]
    : undefined;
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

function findProviderRuntimePluginInLoadedRegistries(params: {
  lookup: ProviderRuntimePluginLookupParams;
  ownerRefs: readonly string[];
}): ProviderPlugin | undefined {
  const find = (registry: PluginRegistry | undefined): ProviderPlugin | undefined => {
    const entry = registry?.providers.find(({ provider: plugin }) =>
      params.ownerRefs.length > 0
        ? matchesProviderLiteralId(plugin, params.lookup.provider) ||
          params.ownerRefs.some((ownerRef) => matchesProviderPluginRef(plugin, ownerRef))
        : matchesProviderPluginRef(plugin, params.lookup.provider),
    );
    return entry ? Object.assign({}, entry.provider, { pluginId: entry.pluginId }) : undefined;
  };
  const generationRegistry = getPluginRuntimeGenerationRegistry();
  if (generationRegistry) {
    return find(generationRegistry);
  }
  return (
    find(getPluginRuntimeGatewayRequestScope()?.pluginRegistry) ??
    find(
      getLoadedRuntimePluginRegistry({
        env: params.lookup.env,
        workspaceDir: params.lookup.workspaceDir,
      }),
    )
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
  const onlyPluginIds = params.onlyPluginIds ? new Set(params.onlyPluginIds) : undefined;
  const filterRegistryPlugins = (registry: PluginRegistry) =>
    registry.providers
      .filter(
        ({ pluginId, provider }) =>
          (!onlyPluginIds || onlyPluginIds.has(pluginId)) &&
          (!params.providerRefs?.length ||
            params.providerRefs.some((providerRef) =>
              matchesProviderPluginRef(provider, providerRef),
            )),
      )
      .map(({ pluginId, provider }) => Object.assign({}, provider, { pluginId }));
  const generationRegistry = getPluginRuntimeGenerationRegistry();
  if (generationRegistry) {
    return filterRegistryPlugins(generationRegistry);
  }
  // An empty generation is authoritative. Outside a generation, only a loaded
  // hit proves the registry serves this query; preparation may discover on a miss.
  const readLoadedRegistry = (registry: PluginRegistry | undefined) => {
    if (registry && registryContainsRuntimePluginIds(registry, params.onlyPluginIds)) {
      const plugins = filterRegistryPlugins(registry);
      return plugins.length > 0 ? plugins : undefined;
    }
    return undefined;
  };
  return (
    readLoadedRegistry(getPluginRuntimeGatewayRequestScope()?.pluginRegistry) ??
    readLoadedRegistry(
      getLoadedRuntimePluginRegistry({
        env: params.env ?? process.env,
        workspaceDir: params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState(),
        requiredPluginIds: params.onlyPluginIds,
      }),
    )
  );
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
  const modelId = resolveProviderRuntimeLookupModelId(params);
  return resolveProviderPluginsForHooks({
    config: params.config,
    workspaceDir,
    env,
    providerRefs,
    modelRefs: modelId
      ? resolveModelCatalogScope({
          cfg: params.config,
          provider: params.provider,
          model: modelId,
        }).modelRefs
      : undefined,
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
  });
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
  const lookup = {
    ...params,
    workspaceDir: params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState(),
    env: params.env,
  };
  return { ...lookup, plugin: resolveProviderRuntimePlugin(lookup) };
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

export function resolveProviderAuthProfileId(
  params: ProviderHookParams<ProviderResolveAuthProfileIdContext>,
): string | undefined {
  const resolved = ensureProviderRuntimePluginHandle(params).plugin?.resolveAuthProfileId?.(
    params.context,
  );
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : undefined;
}

export function resolveProviderFollowupFallbackRoute(
  params: ProviderHookParams<ProviderFollowupFallbackRouteContext>,
): ProviderFollowupFallbackRouteResult | undefined {
  return (
    ensureProviderRuntimePluginHandle(params).plugin?.followupFallbackRoute?.(params.context) ??
    undefined
  );
}

export function wrapProviderSimpleCompletionStreamFn(
  params: ProviderHookParams<ProviderWrapStreamFnContext>,
) {
  return (
    ensureProviderRuntimePluginHandle(params).plugin?.wrapSimpleCompletionStreamFn?.(
      params.context,
    ) ?? undefined
  );
}
