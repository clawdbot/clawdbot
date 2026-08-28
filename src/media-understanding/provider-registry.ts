import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import { providerSupportsCapability } from "../../packages/media-understanding-common/src/provider-supports.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { resolveImageCapableConfigProviderIds } from "./config-provider-models.js";
import { describeImageWithModel, describeImagesWithModel } from "./image-runtime.js";
import type { MediaUnderstandingCapability, MediaUnderstandingProvider } from "./types.js";

export function resolveDefaultMediaModelFromRegistry(params: {
  providerId: string;
  capability: MediaUnderstandingCapability;
  providerRegistry: Map<string, MediaUnderstandingProvider>;
}): string | undefined {
  const provider = params.providerRegistry.get(normalizeMediaProviderId(params.providerId));
  return normalizeOptionalString(provider?.defaultModels?.[params.capability]);
}

export function resolveAutoMediaKeyProvidersFromRegistry(params: {
  capability: MediaUnderstandingCapability;
  providerRegistry: Map<string, MediaUnderstandingProvider>;
}): string[] {
  type AutoProviderEntry = {
    provider: MediaUnderstandingProvider;
    priority: number;
  };
  return [...params.providerRegistry.values()]
    .filter(
      (provider) =>
        provider.capabilities?.includes(params.capability) ??
        providerSupportsCapability(provider, params.capability),
    )
    .map((provider): AutoProviderEntry | null => {
      const priority = provider.autoPriority?.[params.capability];
      return typeof priority === "number" && Number.isFinite(priority)
        ? { provider, priority }
        : null;
    })
    .filter((entry): entry is AutoProviderEntry => entry !== null)
    .toSorted((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.provider.id.localeCompare(right.provider.id);
    })
    .map((entry) => normalizeMediaProviderId(entry.provider.id))
    .filter(Boolean);
}

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
        documentModels: provider.documentModels ?? existing.documentModels,
      }
    : provider;
  registry.set(normalizedKey, hydrateModelBackedMediaProvider(merged));
}

function hydrateModelBackedMediaProvider(
  provider: MediaUnderstandingProvider,
): MediaUnderstandingProvider {
  // Manifest-only image providers can still route through the generic model
  // runtime when they declare image capability but no plugin hook.
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

export {
  normalizeMediaExecutionProviderId,
  normalizeMediaProviderId,
} from "../../packages/media-understanding-common/src/provider-id.js";

/** Builds the media-understanding provider registry from plugin capabilities and config providers. */
export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
  cfg?: OpenClawConfig,
  preparedProviders?: readonly MediaUnderstandingProvider[],
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  const providers =
    preparedProviders ??
    resolvePluginCapabilityProviders({
      key: "mediaUnderstandingProviders",
      cfg,
    });
  for (const provider of providers) {
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

/** Looks up a media-understanding provider using the same id normalization as registry builds. */
export function getMediaUnderstandingProvider(
  id: string,
  registry: Map<string, MediaUnderstandingProvider>,
): MediaUnderstandingProvider | undefined {
  return registry.get(normalizeMediaProviderId(id));
}
