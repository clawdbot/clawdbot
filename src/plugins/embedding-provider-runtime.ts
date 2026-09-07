/** Runtime resolver for plugin-contributed embedding providers. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredGenericEmbeddingProviderId } from "./embedding-provider-config.js";
import {
  getRuntimeEmbeddingProviderAdapter,
  listRuntimeEmbeddingProviderAdapters,
  resolveRuntimeEmbeddingProviderLookupIds,
} from "./embedding-provider-runtime-shared.js";
import {
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";
import {
  PluginRegistryResourceScope,
  createPluginRegistryResourceLease,
  withPluginRegistryResourceScope,
  requirePluginRegistryResourceScope,
} from "./registry-resources.js";
import { getPluginRegistryForContext } from "./runtime.js";

function retainRegisteredEmbeddingProviders(): void {
  const registry = getPluginRegistryForContext();
  if (registry) {
    requirePluginRegistryResourceScope().retain(registry);
  }
}

/** Lists registered adapters retained by the current caller's resource owner. */
export function listRegisteredEmbeddingProviderAdapters(): EmbeddingProviderAdapter[] {
  retainRegisteredEmbeddingProviders();
  return listRegisteredEmbeddingProviders().map((entry) => entry.adapter);
}

/** Lists embedding providers from registered adapters and plugin capabilities. */
export function listEmbeddingProvidersCore(cfg?: OpenClawConfig): EmbeddingProviderAdapter[] {
  return listRuntimeEmbeddingProviderAdapters({
    key: "embeddingProviders",
    cfg,
    registered: listRegisteredEmbeddingProviderAdapters(),
  });
}

function resolveConfiguredEmbeddingProviderId(
  providerId: string,
  cfg?: OpenClawConfig,
): string | undefined {
  return resolveConfiguredGenericEmbeddingProviderId(providerId, cfg);
}

function resolveEmbeddingProviderLookupIds(id: string, cfg?: OpenClawConfig): string[] {
  return resolveRuntimeEmbeddingProviderLookupIds({
    id,
    cfg,
    resolveConfiguredProviderId: resolveConfiguredEmbeddingProviderId,
  });
}

/** Resolves one embedding provider adapter by id, including configured API aliases. */
export function getEmbeddingProviderCore(
  id: string,
  cfg?: OpenClawConfig,
): EmbeddingProviderAdapter | undefined {
  retainRegisteredEmbeddingProviders();
  return getRuntimeEmbeddingProviderAdapter({
    key: "embeddingProviders",
    cfg,
    lookupIds: resolveEmbeddingProviderLookupIds(id, cfg),
    getRegisteredProvider: getRegisteredEmbeddingProvider,
  });
}

/** Retains one adapter's registrations until its created provider has closed. */
export function acquireEmbeddingProvider(id: string, cfg?: OpenClawConfig) {
  const resources = new PluginRegistryResourceScope();
  try {
    const provider = withPluginRegistryResourceScope(resources, () =>
      getEmbeddingProviderCore(id, cfg),
    );
    return { provider, ...createPluginRegistryResourceLease(resources) };
  } catch (error) {
    resources.release();
    throw error;
  }
}
