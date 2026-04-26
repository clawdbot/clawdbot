import type { OpenClawConfig } from "../config/types.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingProvider } from "./types.js";

export function buildMediaUnderstandingManifestMetadataRegistry(
  cfg?: OpenClawConfig,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  for (const plugin of loadPluginManifestRegistryForPluginRegistry({
    config: cfg,
    env: process.env,
    includeDisabled: true,
  }).plugins) {
    const declaredProviders = new Set(
      (plugin.contracts?.mediaUnderstandingProviders ?? []).map((providerId) =>
        normalizeMediaProviderId(providerId),
      ),
    );
    for (const [providerId, metadata] of Object.entries(
      plugin.mediaUnderstandingProviderMetadata ?? {},
    )) {
      const normalizedProviderId = normalizeMediaProviderId(providerId);
      if (!normalizedProviderId || !declaredProviders.has(normalizedProviderId)) {
        continue;
      }
      registry.set(normalizedProviderId, {
        id: normalizedProviderId,
        capabilities: metadata.capabilities,
        defaultModels: metadata.defaultModels,
        autoPriority: metadata.autoPriority,
        nativeDocumentInputs: metadata.nativeDocumentInputs,
      });
    }
  }
  return registry;
}
