import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  createOllamaEmbeddingProvider,
} from "./embedding-provider.js";

export const ollamaMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "ollama",
  defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
  transport: "remote",
  create: async (options) => {
    const { provider, client } = await createOllamaEmbeddingProvider({
      ...options,
      provider: "ollama",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "ollama",
        cacheKeyData: {
          provider: "ollama",
          model: client.model,
        },
      },
    };
  },
};
