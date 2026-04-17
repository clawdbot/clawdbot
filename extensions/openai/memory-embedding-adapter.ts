import {
  isMissingEmbeddingApiKeyError,
  mapBatchEmbeddingsByIndex,
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { OPENAI_BATCH_ENDPOINT, runOpenAiEmbeddingBatches } from "./embedding-batch.js";
import {
  createOpenAiEmbeddingProvider,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
} from "./embedding-provider.js";

export const openAiMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "openai",
  defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "openai",
  autoSelectPriority: 20,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    const { provider, client } = await createOpenAiEmbeddingProvider({
      ...options,
      provider: "openai",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "openai",
        cacheKeyData: {
          provider: "openai",
          baseUrl: client.baseUrl,
          model: client.model,
          headers: sanitizeEmbeddingCacheHeaders(client.headers, ["authorization"]),
        },
        batchEmbed: async (batch) => {
          const byCustomId = await runOpenAiEmbeddingBatches({
            openAi: client,
            agentId: batch.agentId,
            requests: batch.chunks.map((chunk, index) => ({
              custom_id: String(index),
              method: "POST",
              url: OPENAI_BATCH_ENDPOINT,
              body: {
                model: client.model,
                input: chunk.text,
              },
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
