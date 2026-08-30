/**
 * Provider auth alias resolution.
 * Maps deprecated and plugin-defined provider IDs to canonical credential
 * providers, with trusted workspace plugin handling and snapshot-owned metadata.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import {
  getCurrentPluginMetadataSnapshot,
  isScopedPluginMetadataSnapshotRuntimeGeneration,
} from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  isWorkspacePluginAllowedByConfig,
  normalizePluginConfigId,
} from "../plugins/plugin-config-trust.js";
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
  const currentSnapshot = getCurrentPluginMetadataSnapshot({
    config,
    workspaceDir: params?.workspaceDir,
    env,
    allowWorkspaceScopedSnapshot: true,
    requireDefaultDiscoveryContext: config === undefined,
  });
  // Retained execution cannot borrow a newer explicit packet or an ambient
  // cache entry. An empty generation still owns the absence of aliases.
  const capturedSnapshot =
    currentSnapshot && isScopedPluginMetadataSnapshotRuntimeGeneration(currentSnapshot)
      ? currentSnapshot
      : params?.metadataSnapshot;
  const snapshot =
    capturedSnapshot ??
    currentSnapshot ??
    (() => {
      if (!config || normalizePluginsConfig(config.plugins).loadPaths.length !== 0) {
        return undefined;
      }
      return getCurrentPluginMetadataSnapshot({
        ...(params?.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
        env,
        allowWorkspaceScopedSnapshot: true,
        requireDefaultDiscoveryContext: true,
      });
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
