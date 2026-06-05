// Deepinfra plugin module implements memory embedding adapter behavior.
import {
  isMissingEmbeddingApiKeyError,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createDeepInfraEmbeddingProvider,
  DEFAULT_DEEPINFRA_EMBEDDING_MODEL,
} from "./embedding-provider.js";
import type { DeepInfraSurfaceModel } from "./provider-models.js";

// First entry of embedModels becomes the default embedding model.
export function buildDeepInfraMemoryEmbeddingAdapter(options?: {
  embedModels?: readonly DeepInfraSurfaceModel[];
}): MemoryEmbeddingProviderAdapter {
  const defaultModel = options?.embedModels?.[0]?.id ?? DEFAULT_DEEPINFRA_EMBEDDING_MODEL;
  return {
    id: "deepinfra",
    defaultModel,
    transport: "remote",
    authProviderId: "deepinfra",
    autoSelectPriority: 55,
    allowExplicitWhenConfiguredAuto: true,
    shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
    create: async (createOptions) => {
      const { provider, client } = await createDeepInfraEmbeddingProvider({
        ...createOptions,
        provider: "deepinfra",
        fallback: "none",
        defaultModel,
      });
      return {
        provider,
        runtime: {
          id: "deepinfra",
          cacheKeyData: {
            provider: "deepinfra",
            model: client.model,
          },
        },
      };
    },
  };
}

// Back-compat const for callers not yet on the builder.
export const deepinfraMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter =
  buildDeepInfraMemoryEmbeddingAdapter();
