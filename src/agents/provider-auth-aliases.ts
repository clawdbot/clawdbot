/**
 * Provider auth alias resolution.
 * Maps deprecated and plugin-defined provider IDs to canonical credential
 * providers, with trusted workspace plugin handling and snapshot-owned metadata.
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
import { buildPluginMetadataProviderAuthAliases } from "../plugins/plugin-metadata-provider-facts.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type {
  PluginMetadataSnapshot,
  PluginProviderAuthAliasCandidate,
} from "../plugins/plugin-metadata-snapshot.types.js";

/** Inputs that control plugin metadata and trust scope for auth alias lookup. */
export type ProviderAuthAliasLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins"> & {
    owners?: Pick<PluginMetadataSnapshot["owners"], "providerAuthAliases">;
  };
};

/** Provider ids retired by the runtime/auth cutover. Doctor is their migration owner. */
export const PROVIDER_AUTH_ALIAS_MAP = {
  codex: "openai",
  "codex-cli": "openai",
  "openai-codex": "openai",
  "claude-cli": "anthropic",
  "google-gemini-cli": "google",
} as const satisfies Readonly<Record<string, string>>;

export function resolveCanonicalProviderAuthId(provider: string): string {
  const normalized = normalizeProviderId(provider);
  return PROVIDER_AUTH_ALIAS_MAP[normalized as keyof typeof PROVIDER_AUTH_ALIAS_MAP] ?? normalized;
}

function shouldUsePluginAuthAliases(
  plugin: PluginManifestRecord,
  params: ProviderAuthAliasLookupParams | undefined,
): boolean {
  if (plugin.origin !== "workspace" || params?.includeUntrustedWorkspacePlugins === true) {
    return true;
  }
  return isWorkspacePluginAllowedByConfig({
    config: params?.config,
    isImplicitlyAllowed: (pluginId) =>
      normalizePluginConfigId(params?.config?.plugins?.slots?.contextEngine) === pluginId,
    plugin,
  });
}

function resolveProviderAuthAliasCandidates(
  params?: ProviderAuthAliasLookupParams,
): ReadonlyMap<string, readonly PluginProviderAuthAliasCandidate[]> {
  const config = params?.config;
  const context = { env: params?.env ?? process.env, workspaceDir: params?.workspaceDir };
  const lookup = { ...context, allowWorkspaceScopedSnapshot: true };
  const snapshot =
    params?.metadataSnapshot ??
    getCurrentPluginMetadataSnapshot({
      ...lookup,
      config,
      requireDefaultDiscoveryContext: !config,
    }) ??
    (config && normalizePluginsConfig(config.plugins).loadPaths.length === 0
      ? getCurrentPluginMetadataSnapshot({ ...lookup, requireDefaultDiscoveryContext: true })
      : undefined) ??
    loadPluginMetadataSnapshot({ ...context, config: config ?? {} });
  return (
    snapshot.owners?.providerAuthAliases ?? buildPluginMetadataProviderAuthAliases(snapshot.plugins)
  );
}

/** Resolve canonical auth provider aliases from plugin metadata. */
export function resolveProviderAuthAliasMap(
  params?: ProviderAuthAliasLookupParams,
): Record<string, string> {
  const allowedPlugins = new Map<PluginManifestRecord, boolean>();
  const selected: Array<{ alias: string; target: string; order: number }> = [];
  for (const [alias, candidates] of resolveProviderAuthAliasCandidates(params)) {
    let preferred: PluginProviderAuthAliasCandidate | undefined;
    let order = Infinity;
    for (const candidate of candidates) {
      const { plugin } = candidate;
      const allowed = allowedPlugins.get(plugin) ?? shouldUsePluginAuthAliases(plugin, params);
      allowedPlugins.set(plugin, allowed);
      if (allowed) {
        preferred ??= candidate;
        order = Math.min(order, candidate.order);
      }
    }
    if (preferred) {
      selected.push({ alias, target: preferred.target, order });
    }
  }
  const aliases: Record<string, string> = Object.create(null) as Record<string, string>;
  // A later winning owner must not move a key inserted by an earlier eligible owner.
  for (const { alias, target } of selected.toSorted((left, right) => left.order - right.order)) {
    if (!Object.hasOwn(aliases, alias)) {
      aliases[alias] = target;
    }
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
  const staticTarget = resolveCanonicalProviderAuthId(normalized);
  if (staticTarget !== normalized) {
    return staticTarget;
  }
  const candidates = resolveProviderAuthAliasCandidates(params).get(normalized);
  // Package facts are stable; workspace trust follows the current call's config.
  return (
    candidates?.find((candidate) => shouldUsePluginAuthAliases(candidate.plugin, params))?.target ??
    normalized
  );
}
