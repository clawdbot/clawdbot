// Mistral plugin module implements memory embedding adapter behavior.
import {
  buildEmbeddingEndpointCacheIdentity,
  isMissingEmbeddingApiKeyError,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createMistralEmbeddingProvider,
  DEFAULT_MISTRAL_BASE_URL,
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
          ...buildEmbeddingEndpointCacheIdentity({
            baseUrl: client.baseUrl,
            defaultBaseUrl: DEFAULT_MISTRAL_BASE_URL,
            headers: client.headers,
          }),
          model: client.model,
        },
      },
    };
  },
};
