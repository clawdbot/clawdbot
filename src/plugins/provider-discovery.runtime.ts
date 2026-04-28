import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { loadPluginRegistrySnapshot } from "./plugin-registry.js";
import { resolveDiscoveredProviderPluginIds } from "./providers.js";
import { resolvePluginProviders } from "./providers.runtime.js";
import { createPluginSourceLoader } from "./source-loader.js";
import type { ProviderPlugin } from "./types.js";

type ProviderDiscoveryModule =
  | ProviderPlugin
  | ProviderPlugin[]
  | {
      default?: ProviderPlugin | ProviderPlugin[];
      providers?: ProviderPlugin[];
      provider?: ProviderPlugin;
    };

type ProviderDiscoveryEntryResult = {
  providers: ProviderPlugin[];
  complete: boolean;
  pluginRecords: PluginManifestRecord[];
  entryPluginIds: Set<string>;
};

function normalizeDiscoveryModule(value: ProviderDiscoveryModule): ProviderPlugin[] {
  const resolved =
    value && typeof value === "object" && "default" in value && value.default !== undefined
      ? value.default
      : value;
  if (Array.isArray(resolved)) {
    return resolved;
  }
  if (resolved && typeof resolved === "object" && "id" in resolved) {
    return [resolved];
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as { providers?: ProviderPlugin[]; provider?: ProviderPlugin };
    if (Array.isArray(record.providers)) {
      return record.providers;
    }
    if (record.provider) {
      return [record.provider];
    }
  }
  return [];
}

function hasLiveProviderDiscoveryHook(provider: ProviderPlugin): boolean {
  return (
    typeof provider.catalog?.run === "function" || typeof provider.discovery?.run === "function"
  );
}

function hasProviderAuthEnvCredential(
  plugin: PluginManifestRecord,
  env: NodeJS.ProcessEnv,
): boolean {
  return Object.values(plugin.providerAuthEnvVars ?? {}).some((envVars) =>
    envVars.some((name) => {
      const value = env[name]?.trim();
      return value !== undefined && value !== "";
    }),
  );
}

function dedupeSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function resolveProviderDiscoveryEntryPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  includeUntrustedWorkspacePlugins?: boolean;
  requireCompleteDiscoveryEntryCoverage?: boolean;
  discoveryEntriesOnly?: boolean;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry">;
}): ProviderDiscoveryEntryResult {
  const registry = params.pluginMetadataSnapshot?.index ?? loadPluginRegistrySnapshot(params);
  const manifestRegistry =
    params.pluginMetadataSnapshot?.manifestRegistry ??
    loadPluginManifestRegistryForInstalledIndex({
      index: registry,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      includeDisabled: true,
    });
  const pluginIds = resolveDiscoveredProviderPluginIds({
    ...params,
    registry,
    manifestRegistry,
  });
  const pluginIdSet = new Set(pluginIds);
  const pluginRecords = manifestRegistry.plugins.filter((plugin) => pluginIdSet.has(plugin.id));
  const entryRecords = pluginRecords.filter((plugin) => plugin.providerDiscoverySource);
  const entryPluginIds = new Set(entryRecords.map((plugin) => plugin.id));
  if (entryRecords.length === 0) {
    return { providers: [], complete: false, pluginRecords, entryPluginIds };
  }
  const complete = entryRecords.length === pluginIdSet.size;
  if (params.requireCompleteDiscoveryEntryCoverage && !complete) {
    return { providers: [], complete: false, pluginRecords, entryPluginIds };
  }
  const loadSource = createPluginSourceLoader();
  const providers: ProviderPlugin[] = [];
  for (const manifest of entryRecords) {
    try {
      const moduleExport = loadSource(manifest.providerDiscoverySource!) as ProviderDiscoveryModule;
      providers.push(
        ...normalizeDiscoveryModule(moduleExport).map((provider) =>
          Object.assign({}, provider, { pluginId: manifest.id }),
        ),
      );
    } catch {
      // Discovery fast path is optional. Fall back to the full plugin loader
      // below so existing plugin diagnostics/load behavior remains canonical.
      return { providers: [], complete: false, pluginRecords, entryPluginIds };
    }
  }
  return { providers, complete, pluginRecords, entryPluginIds };
}

function resolveSelectiveFullPluginIds(params: {
  entryResult: ProviderDiscoveryEntryResult;
  entryProviders: ProviderPlugin[];
  env: NodeJS.ProcessEnv;
}): string[] {
  const staticOnlyEntryPluginIds = params.entryProviders
    .filter((provider) => !hasLiveProviderDiscoveryHook(provider))
    .map((provider) => provider.pluginId)
    .filter((pluginId): pluginId is string => typeof pluginId === "string" && pluginId !== "");
  const missingEntryCredentialPluginIds = params.entryResult.pluginRecords
    .filter((plugin) => !params.entryResult.entryPluginIds.has(plugin.id))
    .filter((plugin) => hasProviderAuthEnvCredential(plugin, params.env))
    .map((plugin) => plugin.id);
  return dedupeSorted([...staticOnlyEntryPluginIds, ...missingEntryCredentialPluginIds]);
}

export function resolvePluginDiscoveryProvidersRuntime(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  includeUntrustedWorkspacePlugins?: boolean;
  requireCompleteDiscoveryEntryCoverage?: boolean;
  discoveryEntriesOnly?: boolean;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry">;
}): ProviderPlugin[] {
  const env = params.env ?? process.env;
  const entryResult = resolveProviderDiscoveryEntryPlugins(params);
  if (params.discoveryEntriesOnly === true) {
    return entryResult.providers;
  }
  const liveEntryProviders = entryResult.providers.filter(hasLiveProviderDiscoveryHook);
  if (entryResult.complete && liveEntryProviders.length === entryResult.providers.length) {
    return liveEntryProviders;
  }
  if (params.onlyPluginIds === undefined && entryResult.providers.length > 0) {
    const fullPluginIds = resolveSelectiveFullPluginIds({
      entryResult,
      entryProviders: entryResult.providers,
      env,
    });
    const fullProviders =
      fullPluginIds.length > 0
        ? resolvePluginProviders({
            ...params,
            env,
            onlyPluginIds: fullPluginIds,
            bundledProviderAllowlistCompat: true,
          })
        : [];
    return [...liveEntryProviders, ...fullProviders];
  }
  return resolvePluginProviders({
    ...params,
    env,
    bundledProviderAllowlistCompat: true,
  });
}
