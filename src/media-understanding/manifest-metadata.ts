// Manifest metadata registry builder for media-understanding providers without
// loading plugin runtime code.
import type { OpenClawConfig } from "../config/types.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingProvider } from "./types.js";

/** Builds a media provider registry from trusted manifest metadata without loading plugin code. */
export function buildMediaUnderstandingManifestMetadataRegistry(
  cfg?: OpenClawConfig,
  workspaceDir?: string,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  const snapshot = loadManifestMetadataSnapshot({
    config: cfg,
    env: process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
  for (const plugin of snapshot.plugins) {
    // Metadata only counts when the manifest also declares the provider contract.
    const declaredProviders = new Set(
      (plugin.contracts?.mediaUnderstandingProviders ?? []).map((providerId) =>
        normalizeMediaProviderId(providerId),
      ),
    );
    for (const [providerId, metadata] of Object.entries(
      plugin.mediaUnderstandingProviderMetadata ?? {},
    )) {
      // Metadata is trusted only when the plugin also declares the corresponding
      // provider contract; stray manifest fields must not register providers.
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
        documentModels: metadata.documentModels,
      });
    }
  }
  return registry;
}
