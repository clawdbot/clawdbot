import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
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

type PluginEntriesConfig = NonNullable<NonNullable<OpenClawConfig["plugins"]>["entries"]>;

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

function normalizePluginConfigId(id: unknown): string {
  return normalizeOptionalLowercaseString(id) ?? "";
}

function hasPluginId(list: unknown, pluginId: string): boolean {
  return Array.isArray(list) && list.some((entry) => normalizePluginConfigId(entry) === pluginId);
}

function findPluginEntry(
  entries: PluginEntriesConfig | undefined,
  pluginId: string,
): { enabled?: boolean } | undefined {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return undefined;
  }
  for (const [key, value] of Object.entries(entries)) {
    if (normalizePluginConfigId(key) !== pluginId) {
      continue;
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as { enabled?: boolean })
      : {};
  }
  return undefined;
}

function isWorkspacePluginTrustedForAuthAliases(
  plugin: PluginManifestRecord,
  config: OpenClawConfig | undefined,
): boolean {
  const pluginsConfig = config?.plugins;
  if (pluginsConfig?.enabled === false) {
    return false;
  }

  const pluginId = normalizePluginConfigId(plugin.id);
  if (!pluginId || hasPluginId(pluginsConfig?.deny, pluginId)) {
    return false;
  }

  const entry = findPluginEntry(pluginsConfig?.entries, pluginId);
  if (entry?.enabled === false) {
    return false;
  }
  if (entry?.enabled === true || hasPluginId(pluginsConfig?.allow, pluginId)) {
    return true;
  }
  return normalizePluginConfigId(pluginsConfig?.slots?.contextEngine) === pluginId;
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

export function resolveProviderAuthAliasMap(
  params?: ProviderAuthAliasLookupParams,
): Record<string, string> {
  const registry = loadPluginManifestRegistry({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
  });
  const preferredAliases = new Map<string, ProviderAuthAliasCandidate>();
  const aliases: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const plugin of registry.plugins) {
    if (!shouldUsePluginAuthAliases(plugin, params)) {
      continue;
    }
    for (const [alias, target] of Object.entries(plugin.providerAuthAliases ?? {}).toSorted(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const normalizedAlias = normalizeProviderId(alias);
      const normalizedTarget = normalizeProviderId(target);
      if (normalizedAlias && normalizedTarget) {
        const existing = preferredAliases.get(normalizedAlias);
        if (
          !existing ||
          resolveProviderAuthAliasOriginPriority(plugin.origin) <
            resolveProviderAuthAliasOriginPriority(existing.origin)
        ) {
          preferredAliases.set(normalizedAlias, {
            origin: plugin.origin,
            target: normalizedTarget,
          });
        }
      }
    }
  }
  for (const [alias, candidate] of preferredAliases) {
    aliases[alias] = candidate.target;
  }
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
