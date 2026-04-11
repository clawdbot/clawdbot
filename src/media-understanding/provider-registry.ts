import type { OpenClawConfig } from "../config/types.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { describeImageWithModel, describeImagesWithModel } from "./image-runtime.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingProvider } from "./types.js";

type ConfigProvider = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]
>;

type ConfigProviderModel = NonNullable<ConfigProvider["models"]>[number];

function mergeProviderIntoRegistry(
  registry: Map<string, MediaUnderstandingProvider>,
  provider: MediaUnderstandingProvider,
) {
  const normalizedKey = normalizeMediaProviderId(provider.id);
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
  registry.set(normalizedKey, merged);
}

export { normalizeMediaProviderId } from "./provider-id.js";

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
  const configProviders = cfg?.models?.providers;
  if (configProviders && typeof configProviders === "object") {
    for (const [providerKey, providerCfg] of Object.entries(configProviders)) {
      if (!providerKey?.trim()) {
        continue;
      }
      const normalizedKey = normalizeMediaProviderId(providerKey);
      if (registry.has(normalizedKey)) {
        continue;
      }
      const models = providerCfg.models ?? [];
      const hasImageModel = models.some(
        (m: ConfigProviderModel) => Array.isArray(m?.input) && m.input.includes("image"),
      );
      if (hasImageModel) {
        const autoProvider: MediaUnderstandingProvider = {
          id: normalizedKey,
          capabilities: ["image"],
          describeImage: describeImageWithModel,
          describeImages: describeImagesWithModel,
        };
        mergeProviderIntoRegistry(registry, autoProvider);
      }
    }
  }
  if (overrides) {
    for (const [key, provider] of Object.entries(overrides)) {
      const normalizedKey = normalizeMediaProviderId(key);
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
      registry.set(normalizedKey, merged);
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
