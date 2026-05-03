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

type ProviderRuntimePluginLookupParams = {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  applyAutoEnable?: boolean;
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
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

function resolveCompatibleActiveProviderRegistry(
  params: ProviderRuntimePluginLookupParams,
): PluginRegistry | undefined {
  return getLoadedRuntimePluginRegistry({
    env: params.env,
    workspaceDir: params.workspaceDir,
  });
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
  providerRefs?: string[];
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
  const activeRegistry = resolveCompatibleActiveProviderRegistry(params);
  const activePlugin = activeRegistry
    ? findProviderRuntimePluginInRegistry({
        registry: activeRegistry,
        provider: params.provider,
        apiOwnerHint,
      })
    : undefined;
  if (activePlugin) {
    return activePlugin;
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

export function prepareProviderExtraParams(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderPrepareExtraParamsContext;
}) {
  return resolveProviderRuntimePlugin(params)?.prepareExtraParams?.(params.context) ?? undefined;
}

export function resolveProviderExtraParamsForTransport(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderExtraParamsForTransportContext;
}) {
  return (
    resolveProviderRuntimePlugin(params)?.extraParamsForTransport?.(params.context) ?? undefined
  );
}

export function resolveProviderAuthProfileId(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveAuthProfileIdContext;
}): string | undefined {
  const resolved = resolveProviderRuntimePlugin(params)?.resolveAuthProfileId?.(params.context);
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : undefined;
}

export function resolveProviderFollowupFallbackRoute(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFollowupFallbackRouteContext;
}): ProviderFollowupFallbackRouteResult | undefined {
  return resolveProviderHookPlugin(params)?.followupFallbackRoute?.(params.context) ?? undefined;
}

export function wrapProviderStreamFn(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderWrapStreamFnContext;
}) {
  return resolveProviderRuntimePlugin(params)?.wrapStreamFn?.(params.context) ?? undefined;
}
