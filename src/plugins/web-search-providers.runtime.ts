// Runtime bridge for web-search providers supplied by plugins.
import { loadOpenClawPlugins } from "./loader.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginWebSearchProviderEntry } from "./types.js";
import {
  resolveBundledWebSearchProvidersFromPublicArtifacts,
  resolveEnabledBundledWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.js";
import {
  mapRegistryProviders,
  resolveManifestDeclaredWebProviderCandidatePluginIds,
} from "./web-provider-resolution-shared.js";
import { resolvePluginWebProviders } from "./web-provider-runtime-shared.js";
import {
  resolveBundledWebSearchResolutionConfig,
  sortWebSearchProviders,
} from "./web-search-providers.shared.js";

function resolveWebSearchCandidatePluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
  manifestRecords?: readonly PluginManifestRecord[];
}): string[] | undefined {
  return resolveManifestDeclaredWebProviderCandidatePluginIds({
    contract: "webSearchProviders",
    configKey: "webSearch",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: params.onlyPluginIds,
    origin: params.origin,
    manifestRecords: params.manifestRecords,
  });
}

function mapRegistryWebSearchProviders(params: {
  registry: ReturnType<typeof loadOpenClawPlugins>;
  onlyPluginIds?: readonly string[];
}): PluginWebSearchProviderEntry[] {
  return mapRegistryProviders({
    entries: params.registry.webSearchProviders,
    onlyPluginIds: params.onlyPluginIds,
    sortProviders: sortWebSearchProviders,
  });
}

const providerResolution = {
  resolveBundledResolutionConfig: resolveBundledWebSearchResolutionConfig,
  resolveCandidatePluginIds: resolveWebSearchCandidatePluginIds,
  mapRegistryProviders: mapRegistryWebSearchProviders,
};

function resolveLazyBundledWebSearchProviders(
  params: Parameters<typeof resolveEnabledBundledWebSearchProvidersFromPublicArtifacts>[0],
): PluginWebSearchProviderEntry[] | null {
  const providers = resolveEnabledBundledWebSearchProvidersFromPublicArtifacts(params);
  return (
    providers?.map((provider) => {
      const lazyProvider = Object.assign({}, provider);
      lazyProvider.createTool = (context) => {
        // Public descriptors can have setup-only factories; execution belongs to the scoped registry.
        const runtime = resolvePluginWebProviders(
          { ...params, onlyPluginIds: [provider.pluginId] },
          providerResolution,
        ).find((entry) => entry.pluginId === provider.pluginId && entry.id === provider.id);
        return runtime?.createTool(context) ?? null;
      };
      return lazyProvider;
    }) ?? null
  );
}

export function resolvePluginWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  activate?: boolean;
  cache?: boolean;
  mode?: "runtime" | "setup";
  origin?: PluginManifestRecord["origin"];
  manifestRecords?: readonly PluginManifestRecord[];
}): PluginWebSearchProviderEntry[] {
  return resolvePluginWebProviders(params, {
    ...providerResolution,
    resolveBundledPublicArtifactProviders: resolveBundledWebSearchProvidersFromPublicArtifacts,
  });
}

export function resolveRuntimeWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
  manifestRecords?: readonly PluginManifestRecord[];
}): PluginWebSearchProviderEntry[] {
  return resolvePluginWebProviders(params, {
    ...providerResolution,
    resolveBundledRuntimeArtifactProviders: resolveLazyBundledWebSearchProviders,
  });
}
