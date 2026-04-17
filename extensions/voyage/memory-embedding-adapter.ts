import {
  isMissingEmbeddingApiKeyError,
  mapBatchEmbeddingsByIndex,
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { runVoyageEmbeddingBatches } from "./embedding-batch.js";
import {
  createVoyageEmbeddingProvider,
  DEFAULT_VOYAGE_EMBEDDING_MODEL,
} from "./embedding-provider.js";

export const voyageMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "voyage",
  defaultModel: DEFAULT_VOYAGE_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "voyage",
  autoSelectPriority: 40,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    const { provider, client } = await createVoyageEmbeddingProvider({
      ...options,
      provider: "voyage",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "voyage",
        cacheKeyData: {
          provider: "voyage",
          baseUrl: client.baseUrl,
          model: client.model,
          headers: sanitizeEmbeddingCacheHeaders(client.headers, ["authorization"]),
        },
        batchEmbed: async (batch) => {
          const byCustomId = await runVoyageEmbeddingBatches({
            client,
            agentId: batch.agentId,
            requests: batch.chunks.map((chunk, index) => ({
              custom_id: String(index),
              body: { input: chunk.text },
            })),
            wait: batch.wait,
            concurrency: batch.concurrency,
            pollIntervalMs: batch.pollIntervalMs,
            timeoutMs: batch.timeoutMs,
            debug: batch.debug,
          });
          return mapBatchEmbeddingsByIndex(byCustomId, batch.chunks.length);
        },
      },
    };
  },
};
