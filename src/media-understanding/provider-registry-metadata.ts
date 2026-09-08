// Shared selection over prepared provider metadata. Keep runtime registration
// out of manifest/default lookups and preserve the runner's lazy defaults load.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import { providerSupportsCapability } from "../../packages/media-understanding-common/src/provider-supports.js";
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
