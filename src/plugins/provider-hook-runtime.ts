import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizePluginIdScope, serializePluginIdScope } from "./plugin-scope.js";
import { resolveProviderConfigApiOwnerHint } from "./provider-config-owner.js";
import { resolveOwningPluginIdsForProvider } from "./providers.js";
import { isPluginProvidersLoadInFlight, resolvePluginProviders } from "./providers.runtime.js";
import { resolvePluginCacheInputs } from "./roots.js";
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

function matchesProviderLiteralId(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(providerId);
  return !!normalized && normalizeLowercaseStringOrEmpty(provider.id) === normalized;
}

let cachedHookProviders = new WeakMap<NodeJS.ProcessEnv, Map<string, ProviderPlugin[]>>();

function resolveHookProviderCacheBucket(env: NodeJS.ProcessEnv) {
  let bucket = cachedHookProviders.get(env);
  if (!bucket) {
    bucket = new Map<string, ProviderPlugin[]>();
    cachedHookProviders.set(env, bucket);
  }
  return bucket;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function projectPluginEntryForProviderHookCache(
  pluginId: string,
  entry: unknown,
  fullConfigPluginIds: ReadonlySet<string>,
): unknown {
  if (!isRecord(entry) || fullConfigPluginIds.has(pluginId)) {
    return entry;
  }
  const {
    config: _config,
    hooks: _hooks,
    subagent: _subagent,
    apiKey: _apiKey,
    env: _env,
    ...rest
  } = entry;
  return rest;
}

function projectPluginsConfigForProviderHookCache(
  plugins: OpenClawConfig["plugins"],
  fullConfigPluginIds: ReadonlySet<string>,
): unknown {
  if (!isRecord(plugins)) {
    return plugins ?? null;
  }
  const entries = isRecord(plugins.entries)
    ? Object.fromEntries(
        Object.entries(plugins.entries)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([pluginId, entry]) => [
            pluginId,
            projectPluginEntryForProviderHookCache(pluginId, entry, fullConfigPluginIds),
          ]),
      )
    : plugins.entries;
  return {
    ...plugins,
    entries,
  };
}

function resolveProviderOwnerConfigPluginIds(params: {
  providerRefs?: readonly string[];
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  if (!params.providerRefs?.length) {
    return [];
  }
  const pluginIds = new Set<string>();
  for (const provider of params.providerRefs) {
    for (const pluginId of resolveOwningPluginIdsForProvider({
      provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }) ?? []) {
      pluginIds.add(pluginId);
    }
    const apiOwnerHint = resolveProviderConfigApiOwnerHint({
      provider,
      config: params.config,
    });
    if (!apiOwnerHint) {
      continue;
    }
    for (const pluginId of resolveOwningPluginIdsForProvider({
      provider: apiOwnerHint,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }) ?? []) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

export function resolveProviderHookConfigCacheShape(
  config: OpenClawConfig | undefined,
  fullConfigPluginIds: readonly string[] | undefined,
): unknown {
  if (!config) {
    return null;
  }
  const fullConfigPluginIdSet = new Set(fullConfigPluginIds ?? []);
  return {
    plugins: projectPluginsConfigForProviderHookCache(config.plugins, fullConfigPluginIdSet),
  };
}

function buildHookProviderCacheKey(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  onlyPluginIds?: string[];
  providerRefs?: string[];
  env?: NodeJS.ProcessEnv;
  fullConfigPluginIds?: string[];
  applyAutoEnable?: boolean;
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
  installBundledRuntimeDeps?: boolean;
}) {
  const { roots } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const onlyPluginIds = normalizePluginIdScope(params.onlyPluginIds);
  const loadPolicy = {
    applyAutoEnable: params.applyAutoEnable ?? true,
    bundledProviderAllowlistCompat: params.bundledProviderAllowlistCompat ?? true,
    bundledProviderVitestCompat: params.bundledProviderVitestCompat ?? true,
    installBundledRuntimeDeps: params.installBundledRuntimeDeps ?? false,
  };
  return `${roots.workspace ?? ""}::${roots.global}::${roots.stock ?? ""}::${JSON.stringify(resolveProviderHookConfigCacheShape(params.config, params.fullConfigPluginIds))}::${serializePluginIdScope(onlyPluginIds)}::${JSON.stringify(params.providerRefs ?? [])}::${JSON.stringify(loadPolicy)}`;
}

export function clearProviderRuntimeHookCache(): void {
  cachedHookProviders = new WeakMap<NodeJS.ProcessEnv, Map<string, ProviderPlugin[]>>();
}

export function resetProviderRuntimeHookCacheForTest(): void {
  clearProviderRuntimeHookCache();
}

export const __testing = {
  buildHookProviderCacheKey,
} as const;

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
  const cacheBucket = resolveHookProviderCacheBucket(env);
  const onlyPluginIds = normalizePluginIdScope(params.onlyPluginIds);
  const explicitPluginIds = onlyPluginIds ?? [];
  const fullConfigPluginIds = [
    ...new Set([
      ...explicitPluginIds,
      ...resolveProviderOwnerConfigPluginIds({
        providerRefs: params.providerRefs,
        config: params.config,
        workspaceDir,
        env,
      }),
    ]),
  ].toSorted((left, right) => left.localeCompare(right));
  const cacheKey = buildHookProviderCacheKey({
    config: params.config,
    workspaceDir,
    onlyPluginIds,
    providerRefs: params.providerRefs,
    env,
    fullConfigPluginIds,
    applyAutoEnable: params.applyAutoEnable,
    bundledProviderAllowlistCompat: params.bundledProviderAllowlistCompat,
    bundledProviderVitestCompat: params.bundledProviderVitestCompat,
    installBundledRuntimeDeps: params.installBundledRuntimeDeps,
  });
  const cached = cacheBucket.get(cacheKey);
  if (cached) {
    return cached;
  }
  if (
    isPluginProvidersLoadInFlight({
      ...params,
      workspaceDir,
      env,
      activate: false,
      cache: false,
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
    cache: false,
    applyAutoEnable: params.applyAutoEnable,
    bundledProviderAllowlistCompat: params.bundledProviderAllowlistCompat ?? true,
    bundledProviderVitestCompat: params.bundledProviderVitestCompat ?? true,
    installBundledRuntimeDeps: params.installBundledRuntimeDeps,
  });
  cacheBucket.set(cacheKey, resolved);
  return resolved;
}

export function resolveProviderRuntimePlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  applyAutoEnable?: boolean;
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
  installBundledRuntimeDeps?: boolean;
}): ProviderPlugin | undefined {
  const apiOwnerHint = resolveProviderConfigApiOwnerHint({
    provider: params.provider,
    config: params.config,
  });
  return resolveProviderPluginsForHooks({
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
  return resolveProviderHookPlugin(params)?.extraParamsForTransport?.(params.context) ?? undefined;
}

export function resolveProviderAuthProfileId(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveAuthProfileIdContext;
}): string | undefined {
  const resolved = resolveProviderHookPlugin(params)?.resolveAuthProfileId?.(params.context);
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
  return resolveProviderHookPlugin(params)?.wrapStreamFn?.(params.context) ?? undefined;
}
