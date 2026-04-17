import {
  isMissingEmbeddingApiKeyError,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createMistralEmbeddingProvider,
  DEFAULT_MISTRAL_EMBEDDING_MODEL,
} from "./embedding-provider.js";

export const mistralMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "mistral",
  defaultModel: DEFAULT_MISTRAL_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "mistral",
  autoSelectPriority: 50,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    const { provider, client } = await createMistralEmbeddingProvider({
      ...options,
      provider: "mistral",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "mistral",
        cacheKeyData: {
          provider: "mistral",
          model: client.model,
        },
      },
    };
  },
};
