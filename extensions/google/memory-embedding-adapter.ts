import {
  hasNonTextEmbeddingParts,
  isMissingEmbeddingApiKeyError,
  mapBatchEmbeddingsByIndex,
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { runGeminiEmbeddingBatches } from "./embedding-batch.js";
import {
  buildGeminiEmbeddingRequest,
  createGeminiEmbeddingProvider,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
} from "./embedding-provider.js";

function supportsGeminiMultimodalEmbeddings(model: string): boolean {
  const normalized = model
    .trim()
    .replace(/^models\//, "")
    .replace(/^(gemini|google)\//, "");
  return normalized === "gemini-embedding-2-preview";
}

export const geminiMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "gemini",
  defaultModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "google",
  autoSelectPriority: 30,
  allowExplicitWhenConfiguredAuto: true,
  supportsMultimodalEmbeddings: ({ model }) => supportsGeminiMultimodalEmbeddings(model),
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    const { provider, client } = await createGeminiEmbeddingProvider({
      ...options,
      provider: "gemini",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "gemini",
        cacheKeyData: {
          provider: "gemini",
          baseUrl: client.baseUrl,
          model: client.model,
          outputDimensionality: client.outputDimensionality,
          headers: sanitizeEmbeddingCacheHeaders(client.headers, [
            "authorization",
            "x-goog-api-key",
          ]),
        },
        batchEmbed: async (batch) => {
          if (batch.chunks.some((chunk) => hasNonTextEmbeddingParts(chunk.embeddingInput))) {
            return null;
          }
          const byCustomId = await runGeminiEmbeddingBatches({
            gemini: client,
            agentId: batch.agentId,
            requests: batch.chunks.map((chunk, index) => ({
              custom_id: String(index),
              request: buildGeminiEmbeddingRequest({
                input: chunk.embeddingInput ?? { text: chunk.text },
                taskType: "RETRIEVAL_DOCUMENT",
                modelPath: client.modelPath,
                outputDimensionality: client.outputDimensionality,
              }),
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
