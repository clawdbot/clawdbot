// Openai plugin module implements memory embedding adapter behavior.
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

function resolveEmbeddingCacheExcludedHeaders(providerId: string, baseUrl: string): string[] {
  const excludedHeaders = ["authorization", "x-api-key"];
  if (providerId !== "openai") {
    return excludedHeaders;
  }
  try {
    if (new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/, "") === "api.openai.com") {
      // Native attribution changes on every upgrade; cache identity must describe embeddings,
      // not the OpenClaw build that requested them.
      excludedHeaders.push("version", "user-agent");
    }
  } catch {
    // Invalid URLs are handled by the embedding client; keep existing custom-header identity.
  }
  return excludedHeaders;
}

export const openAiMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "openai",
  defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "openai",
  autoSelectPriority: 20,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    const resolvedProvider = options.provider ?? "openai";
    const { provider, client } = await createOpenAiEmbeddingProvider({
      ...options,
      provider: resolvedProvider,
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "openai",
        sourceWideBatchEmbed: true,
        cacheKeyData: {
          provider: resolvedProvider,
          baseUrl: client.baseUrl,
          model: client.model,
          outputDimensionality: client.outputDimensionality,
          documentInputType: client.documentInputType ?? client.inputType,
          headers: sanitizeEmbeddingCacheHeaders(
            client.headers,
            resolveEmbeddingCacheExcludedHeaders(resolvedProvider, client.baseUrl),
          ),
        },
        batchEmbed: async (batch) => {
          const inputType = client.documentInputType ?? client.inputType;
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
                ...(typeof client.outputDimensionality === "number"
                  ? { dimensions: client.outputDimensionality }
                  : {}),
                ...(inputType ? { input_type: inputType } : {}),
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
