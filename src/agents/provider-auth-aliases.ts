import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  isWorkspacePluginAllowedByConfig,
  normalizePluginConfigId,
} from "../plugins/plugin-config-trust.js";
import { resolvePluginControlPlaneFingerprint } from "../plugins/plugin-control-plane-context.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { normalizeProviderId } from "./provider-id.js";

export type ProviderAuthAliasLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
};

type ProviderAuthAliasCandidate = {
  origin?: PluginOrigin;
  target: string;
};

const PROVIDER_AUTH_ALIAS_ORIGIN_PRIORITY: Readonly<Record<PluginOrigin, number>> = {
  config: 0,
  bundled: 1,
  global: 2,
  workspace: 3,
};
let providerAuthAliasMapCache = new WeakMap<
  NodeJS.ProcessEnv,
  Map<string, Record<string, string>>
>();

function buildProviderAuthAliasMapCacheKey(
  params: ProviderAuthAliasLookupParams | undefined,
  env: NodeJS.ProcessEnv,
): string {
  return JSON.stringify({
    pluginControlPlane: resolvePluginControlPlaneFingerprint({
      config: params?.config,
      env,
      workspaceDir: params?.workspaceDir,
    }),
    includeUntrustedWorkspacePlugins: params?.includeUntrustedWorkspacePlugins === true,
    plugins: params?.config?.plugins ?? null,
  });
}

export function resetProviderAuthAliasMapCacheForTest(): void {
  providerAuthAliasMapCache = new WeakMap<NodeJS.ProcessEnv, Map<string, Record<string, string>>>();
}

function resolveProviderAuthAliasOriginPriority(origin: PluginOrigin | undefined): number {
  if (!origin) {
    return Number.MAX_SAFE_INTEGER;
  }
  return PROVIDER_AUTH_ALIAS_ORIGIN_PRIORITY[origin] ?? Number.MAX_SAFE_INTEGER;
}

function isWorkspacePluginTrustedForAuthAliases(
  plugin: PluginManifestRecord,
  config: OpenClawConfig | undefined,
): boolean {
  return isWorkspacePluginAllowedByConfig({
    config,
    isImplicitlyAllowed: (pluginId) =>
      normalizePluginConfigId(config?.plugins?.slots?.contextEngine) === pluginId,
    plugin,
  });
}

function shouldUsePluginAuthAliases(
  plugin: PluginManifestRecord,
  params: ProviderAuthAliasLookupParams | undefined,
): boolean {
  if (plugin.origin !== "workspace" || params?.includeUntrustedWorkspacePlugins === true) {
    return true;
  }
  return isWorkspacePluginTrustedForAuthAliases(plugin, params?.config);
}

function setPreferredAlias(params: {
  aliases: Map<string, ProviderAuthAliasCandidate>;
  alias: string;
  origin?: PluginOrigin;
  target: string;
}) {
  const normalizedAlias = normalizeProviderId(params.alias);
  const normalizedTarget = normalizeProviderId(params.target);
  if (!normalizedAlias || !normalizedTarget) {
    return;
  }
  const existing = params.aliases.get(normalizedAlias);
  if (
    !existing ||
    resolveProviderAuthAliasOriginPriority(params.origin) <
      resolveProviderAuthAliasOriginPriority(existing.origin)
  ) {
    params.aliases.set(normalizedAlias, {
      origin: params.origin,
      target: normalizedTarget,
    });
  }
}

export function resolveProviderAuthAliasMap(
  params?: ProviderAuthAliasLookupParams,
): Record<string, string> {
  const env = params?.env ?? process.env;
  const cacheKey = buildProviderAuthAliasMapCacheKey(params, env);
  let envCache = providerAuthAliasMapCache.get(env);
  if (!envCache) {
    envCache = new Map<string, Record<string, string>>();
    providerAuthAliasMapCache.set(env, envCache);
  }
  const cached = envCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const snapshot = loadPluginMetadataSnapshot({
    config: params?.config ?? {},
    workspaceDir: params?.workspaceDir,
    env,
  });
  const preferredAliases = new Map<string, ProviderAuthAliasCandidate>();
  const aliases: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const plugin of snapshot.plugins) {
    if (!shouldUsePluginAuthAliases(plugin, params)) {
      continue;
    }
    for (const [alias, target] of Object.entries(plugin.providerAuthAliases ?? {}).toSorted(
      ([left], [right]) => left.localeCompare(right),
    )) {
      setPreferredAlias({
        aliases: preferredAliases,
        alias,
        origin: plugin.origin,
        target,
      });
    }
    for (const choice of plugin.providerAuthChoices ?? []) {
      for (const deprecatedChoiceId of choice.deprecatedChoiceIds ?? []) {
        setPreferredAlias({
          aliases: preferredAliases,
          alias: deprecatedChoiceId,
          origin: plugin.origin,
          target: choice.provider,
        });
      }
    }
  }
  for (const [alias, candidate] of preferredAliases) {
    aliases[alias] = candidate.target;
  }
  envCache.set(cacheKey, aliases);
  return aliases;
}

export function resolveProviderIdForAuth(
  provider: string,
  params?: ProviderAuthAliasLookupParams,
): string {
  const normalized = normalizeProviderId(provider);
  if (!normalized) {
    return normalized;
  }
  return resolveProviderAuthAliasMap(params)[normalized] ?? normalized;
}
