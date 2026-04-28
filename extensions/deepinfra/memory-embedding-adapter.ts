import {
  isMissingEmbeddingApiKeyError,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createDeepInfraEmbeddingProvider,
  DEFAULT_DEEPINFRA_EMBEDDING_MODEL,
} from "./embedding-provider.js";

export const deepinfraMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "deepinfra",
  defaultModel: DEFAULT_DEEPINFRA_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "deepinfra",
  autoSelectPriority: 55,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    const { provider, client } = await createDeepInfraEmbeddingProvider({
      ...options,
      provider: "deepinfra",
      fallback: "none",
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
