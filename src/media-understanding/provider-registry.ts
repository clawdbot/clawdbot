import type { OpenClawConfig } from "../config/types.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { resolveImageCapableConfigProviderIds } from "./config-provider-models.js";
import { describeImageWithModel, describeImagesWithModel } from "./image-runtime.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingProvider } from "./types.js";

function mergeProviderIntoRegistry(
  registry: Map<string, MediaUnderstandingProvider>,
  provider: MediaUnderstandingProvider,
  registryKey = provider.id,
) {
  const normalizedKey = normalizeMediaProviderId(registryKey);
  const existing = registry.get(normalizedKey);
  const merged = existing
    ? {
        ...existing,
        ...provider,
        capabilities: provider.capabilities ?? existing.capabilities,
        defaultModels: provider.defaultModels ?? existing.defaultModels,
        autoPriority: provider.autoPriority ?? existing.autoPriority,
        nativeDocumentInputs: provider.nativeDocumentInputs ?? existing.nativeDocumentInputs,
      }
    : provider;
  registry.set(normalizedKey, hydrateModelBackedMediaProvider(merged));
}

function hydrateModelBackedMediaProvider(
  provider: MediaUnderstandingProvider,
): MediaUnderstandingProvider {
  if (!provider.capabilities?.includes("image")) {
    return provider;
  }
  if (provider.describeImage && provider.describeImages) {
    return provider;
  }
  return {
    ...provider,
    describeImage: provider.describeImage ?? describeImageWithModel,
    describeImages: provider.describeImages ?? describeImagesWithModel,
  };
}

export { normalizeMediaExecutionProviderId, normalizeMediaProviderId } from "./provider-id.js";

export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
  cfg?: OpenClawConfig,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  for (const provider of resolvePluginCapabilityProviders({
    key: "mediaUnderstandingProviders",
    cfg,
  })) {
    mergeProviderIntoRegistry(registry, provider);
  }
  // Auto-register media-understanding for config providers with image-capable models (#51392)
  for (const normalizedKey of resolveImageCapableConfigProviderIds(cfg)) {
    if (!registry.has(normalizedKey)) {
      mergeProviderIntoRegistry(registry, {
        id: normalizedKey,
        capabilities: ["image"],
        describeImage: describeImageWithModel,
        describeImages: describeImagesWithModel,
      });
    }
  }
  if (overrides) {
    for (const [key, provider] of Object.entries(overrides)) {
      mergeProviderIntoRegistry(registry, provider, key);
    }
  }
  return registry;
}

export function getMediaUnderstandingProvider(
  id: string,
  registry: Map<string, MediaUnderstandingProvider>,
): MediaUnderstandingProvider | undefined {
  return registry.get(normalizeMediaProviderId(id));
}
