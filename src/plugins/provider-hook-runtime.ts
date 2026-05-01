import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveProviderConfigApiOwnerHint } from "./provider-config-owner.js";
import { isPluginProvidersLoadInFlight, resolvePluginProviders } from "./providers.runtime.js";
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

const providerRuntimePluginCache = new WeakMap<
  OpenClawConfig,
  Map<string, ProviderPlugin | null>
>();

type ProviderRuntimePluginLookupParams = {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  applyAutoEnable?: boolean;
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
  installBundledRuntimeDeps?: boolean;
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
    plugins: params.config?.plugins,
    models: params.config?.models?.providers,
    workspaceDir: params.workspaceDir ?? "",
    applyAutoEnable: params.applyAutoEnable ?? null,
    bundledProviderAllowlistCompat: params.bundledProviderAllowlistCompat ?? null,
    bundledProviderVitestCompat: params.bundledProviderVitestCompat ?? null,
    installBundledRuntimeDeps: params.installBundledRuntimeDeps ?? null,
  });
}

function resolveProviderRuntimePluginCache(
  params: ProviderRuntimePluginLookupParams,
): Map<string, ProviderPlugin | null> | undefined {
  if (!params.config || (params.env && params.env !== process.env)) {
    return undefined;
  }
  let cache = providerRuntimePluginCache.get(params.config);
  if (!cache) {
    cache = new Map();
    providerRuntimePluginCache.set(params.config, cache);
  }
  return cache;
}

function matchesProviderLiteralId(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(providerId);
  return !!normalized && normalizeLowercaseStringOrEmpty(provider.id) === normalized;
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
  installBundledRuntimeDeps?: boolean;
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
      installBundledRuntimeDeps: params.installBundledRuntimeDeps,
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
    installBundledRuntimeDeps: params.installBundledRuntimeDeps,
  });
  return resolved;
}

export function resolveProviderRuntimePlugin(
  params: ProviderRuntimePluginLookupParams,
): ProviderPlugin | undefined {
  const cache = resolveProviderRuntimePluginCache(params);
  const cacheKey = cache ? resolveProviderRuntimePluginCacheKey(params) : "";
  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey) ?? undefined;
  }
  const apiOwnerHint = resolveProviderConfigApiOwnerHint({
    provider: params.provider,
    config: params.config,
  });
  const plugin = resolveProviderPluginsForHooks({
    config: params.config,
    workspaceDir: params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState(),
    env: params.env,
    providerRefs: apiOwnerHint ? [params.provider, apiOwnerHint] : [params.provider],
    applyAutoEnable: params.applyAutoEnable,
    bundledProviderAllowlistCompat: params.bundledProviderAllowlistCompat,
    bundledProviderVitestCompat: params.bundledProviderVitestCompat,
    installBundledRuntimeDeps: params.installBundledRuntimeDeps,
  }).find((plugin) => {
    if (apiOwnerHint) {
      return (
        matchesProviderLiteralId(plugin, params.provider) || matchesProviderId(plugin, apiOwnerHint)
      );
    }
    return matchesProviderId(plugin, params.provider);
  });
  cache?.set(cacheKey, plugin ?? null);
  return plugin;
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
