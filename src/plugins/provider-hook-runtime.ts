import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import {
  resolveConfigScopedRuntimeCacheValue,
  type ConfigScopedRuntimeCache,
} from "./plugin-cache-primitives.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";
import { resolveProviderConfigApiOwnerHint } from "./provider-config-owner.js";
import { isPluginProvidersLoadInFlight, resolvePluginProviders } from "./providers.runtime.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";
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
const PREPARED_PROVIDER_RUNTIME_SURFACES = ["channel"] as const;

export type ProviderRuntimePluginLookupParams = {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  applyAutoEnable?: boolean;
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
};

export type ProviderRuntimePluginHandle = ProviderRuntimePluginLookupParams & {
  plugin?: ProviderPlugin;
};

export type ProviderRuntimePluginHandleParams = ProviderRuntimePluginLookupParams & {
  runtimeHandle?: ProviderRuntimePluginHandle;
};

function matchesProviderId(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return false;
  }
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
    (alias) => normalizeProviderId(alias) === normalized,
  );
}

function resolveProviderRuntimePluginCacheKey(params: ProviderRuntimePluginLookupParams): string {
  return JSON.stringify({
    provider: normalizeLowercaseStringOrEmpty(params.provider),
    pluginControlPlane: resolvePluginControlPlaneFingerprint({
      config: params.config,
      env: params.env,
      workspaceDir: params.workspaceDir,
    }),
    plugins: params.config?.plugins,
    models: params.config?.models?.providers,
    workspaceDir: params.workspaceDir ?? "",
    applyAutoEnable: params.applyAutoEnable ?? null,
    bundledProviderAllowlistCompat: params.bundledProviderAllowlistCompat ?? null,
    bundledProviderVitestCompat: params.bundledProviderVitestCompat ?? null,
  });
}

function matchesProviderLiteralId(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(providerId);
  return !!normalized && normalizeLowercaseStringOrEmpty(provider.id) === normalized;
}

function findProviderRuntimePluginInLoadedRegistries(params: {
  lookup: ProviderRuntimePluginLookupParams;
  apiOwnerHint?: string;
}): ProviderPlugin | undefined {
  const activeRegistry = getLoadedRuntimePluginRegistry({
    env: params.lookup.env,
    workspaceDir: params.lookup.workspaceDir,
  });
  const activePlugin = activeRegistry
    ? findProviderRuntimePluginInRegistry({
        registry: activeRegistry,
        provider: params.lookup.provider,
        apiOwnerHint: params.apiOwnerHint,
      })
    : undefined;
  if (activePlugin) {
    return activePlugin;
  }
  for (const surface of PREPARED_PROVIDER_RUNTIME_SURFACES) {
    const registry = getLoadedRuntimePluginRegistry({
      env: params.lookup.env,
      workspaceDir: params.lookup.workspaceDir,
      surface,
    });
    const plugin = registry
      ? findProviderRuntimePluginInRegistry({
          registry,
          provider: params.lookup.provider,
          apiOwnerHint: params.apiOwnerHint,
        })
      : undefined;
    if (plugin) {
      return plugin;
    }
  }
  return undefined;
}

function findProviderRuntimePluginInRegistry(params: {
  registry: PluginRegistry;
  provider: string;
  apiOwnerHint?: string;
}): ProviderPlugin | undefined {
  return params.registry.providers
    .map((entry) => Object.assign({}, entry.provider, { pluginId: entry.pluginId }))
    .find((plugin) => {
      if (params.apiOwnerHint) {
        return (
          matchesProviderLiteralId(plugin, params.provider) ||
          matchesProviderId(plugin, params.apiOwnerHint)
        );
      }
      return matchesProviderId(plugin, params.provider);
    });
}

export function resolveProviderPluginsForHooks(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  providerRefs?: readonly string[];
  applyAutoEnable?: boolean;
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
}): ProviderPlugin[] {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  if (
    isPluginProvidersLoadInFlight({
      ...params,
      workspaceDir,
      env,
      activate: false,
      applyAutoEnable: params.applyAutoEnable,
      bundledProviderAllowlistCompat: params.bundledProviderAllowlistCompat ?? true,
      bundledProviderVitestCompat: params.bundledProviderVitestCompat ?? true,
    })
  ) {
    return [];
  }
  const resolved = resolvePluginProviders({
    ...params,
    workspaceDir,
    env,
    activate: false,
    applyAutoEnable: params.applyAutoEnable,
    bundledProviderAllowlistCompat: params.bundledProviderAllowlistCompat ?? true,
    bundledProviderVitestCompat: params.bundledProviderVitestCompat ?? true,
  });
  return resolved;
}

export function resolveProviderRuntimePlugin(
  params: ProviderRuntimePluginLookupParams,
): ProviderPlugin | undefined {
  const apiOwnerHint = resolveProviderConfigApiOwnerHint({
    provider: params.provider,
    config: params.config,
  });
  const loadedPlugin = findProviderRuntimePluginInLoadedRegistries({
    lookup: params,
    apiOwnerHint,
  });
  if (loadedPlugin) {
    return loadedPlugin;
  }
  const cacheConfig = params.env && params.env !== process.env ? undefined : params.config;
  const plugin = resolveConfigScopedRuntimeCacheValue({
    cache: providerRuntimePluginCache,
    config: cacheConfig,
    key: resolveProviderRuntimePluginCacheKey(params),
    load: () => {
      return (
        resolveProviderPluginsForHooks({
          config: params.config,
          workspaceDir: params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState(),
          env: params.env,
          providerRefs: apiOwnerHint ? [params.provider, apiOwnerHint] : [params.provider],
          applyAutoEnable: params.applyAutoEnable,
          bundledProviderAllowlistCompat: params.bundledProviderAllowlistCompat,
          bundledProviderVitestCompat: params.bundledProviderVitestCompat,
        }).find((plugin) => {
          if (apiOwnerHint) {
            return (
              matchesProviderLiteralId(plugin, params.provider) ||
              matchesProviderId(plugin, apiOwnerHint)
            );
          }
          return matchesProviderId(plugin, params.provider);
        }) ?? null
      );
    },
  });
  return plugin ?? undefined;
}

export function resolveLoadedProviderRuntimePlugin(
  params: ProviderRuntimePluginLookupParams,
): ProviderPlugin | undefined {
  const apiOwnerHint = resolveProviderConfigApiOwnerHint({
    provider: params.provider,
    config: params.config,
  });
  return findProviderRuntimePluginInLoadedRegistries({
    lookup: params,
    apiOwnerHint,
  });
}

export function resolveProviderHookPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin | undefined {
  return (
    resolveProviderRuntimePlugin(params) ??
    resolveProviderPluginsForHooks({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }).find((candidate) => matchesProviderId(candidate, params.provider))
  );
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
  return params.runtimeHandle ?? resolveProviderRuntimePluginHandle(params);
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
