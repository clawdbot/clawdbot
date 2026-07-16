/**
 * Provider auth alias resolution.
 * Maps deprecated and plugin-defined provider IDs to canonical credential
 * providers, with trusted workspace plugin handling and process-stable caching.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  isWorkspacePluginAllowedByConfig,
  normalizePluginConfigId,
} from "../plugins/plugin-config-trust.js";
import { resolvePluginControlPlaneFingerprint } from "../plugins/plugin-control-plane-context.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";

/** Inputs that control plugin metadata and trust scope for auth alias lookup. */
export type ProviderAuthAliasLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
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

/** Clear provider auth alias cache for tests that mutate plugin metadata. */
function resetProviderAuthAliasMapCacheForTest(): void {
  providerAuthAliasMapCache = new WeakMap<NodeJS.ProcessEnv, Map<string, Record<string, string>>>();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.providerAuthAliasesTestApi")] =
    {
      resetProviderAuthAliasMapCacheForTest,
    };
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

/** Resolve canonical auth provider aliases from plugin metadata. */
export function resolveProviderAuthAliasMap(
  params?: ProviderAuthAliasLookupParams,
): Record<string, string> {
  const env = params?.env ?? process.env;
  const config = params?.config;
  let cacheKey: string | undefined;
  let envCache: Map<string, Record<string, string>> | undefined;
  if (!params?.metadataSnapshot) {
    // Plugin metadata is process-stable for a control-plane fingerprint, so
    // cache per env object without hiding explicit test snapshots.
    cacheKey = buildProviderAuthAliasMapCacheKey(params, env);
    envCache = providerAuthAliasMapCache.get(env);
    if (!envCache) {
      envCache = new Map<string, Record<string, string>>();
      providerAuthAliasMapCache.set(env, envCache);
    }
    const cached = envCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }
  const snapshot =
    params?.metadataSnapshot ??
    (config
      ? getCurrentPluginMetadataSnapshot({
          config,
          ...(params?.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
          env,
          allowWorkspaceScopedSnapshot: true,
        })
      : getCurrentPluginMetadataSnapshot({
          ...(params?.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
          env,
          allowWorkspaceScopedSnapshot: true,
          requireDefaultDiscoveryContext: true,
        })) ??
    (() => {
      if (!config || normalizePluginsConfig(config.plugins).loadPaths.length !== 0) {
        return undefined;
      }
      const currentSnapshot = getCurrentPluginMetadataSnapshot({
        ...(params?.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
        env,
        allowWorkspaceScopedSnapshot: true,
        requireDefaultDiscoveryContext: true,
      });
      return currentSnapshot;
    })() ??
    loadPluginMetadataSnapshot({
      config: config ?? {},
      ...(params?.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
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
  if (envCache && cacheKey) {
    envCache.set(cacheKey, aliases);
  }
  return aliases;
}

/** Resolve the provider ID that should be used for credential lookup. */
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
