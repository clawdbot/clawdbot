import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
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

function resolveProviderDiscoveryEntryPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): ProviderPlugin[] {
  const pluginIds = resolveDiscoveredProviderPluginIds(params);
  const pluginIdSet = new Set(pluginIds);
  const records = loadPluginManifestRegistry(params).plugins.filter(
    (plugin) => plugin.providerDiscoverySource && pluginIdSet.has(plugin.id),
  );
  if (records.length === 0) {
    return [];
  }
  const loadSource = createPluginSourceLoader();
  const providers: ProviderPlugin[] = [];
  for (const manifest of records) {
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
      return [];
    }
  }
  return providers;
}

export function resolvePluginDiscoveryProvidersRuntime(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): ProviderPlugin[] {
  const entryProviders = resolveProviderDiscoveryEntryPlugins(params);
  if (entryProviders.length > 0) {
    return entryProviders;
  }
  return resolvePluginProviders({
    ...params,
    bundledProviderAllowlistCompat: true,
  });
}
