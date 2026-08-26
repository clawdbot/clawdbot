// Deepinfra plugin module adapts its text embedding runtime to the generic provider contract.
import type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/embedding-providers";
import {
  embeddingProviderOwnsDestination,
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createDeepInfraEmbeddingProvider,
  DEFAULT_DEEPINFRA_EMBEDDING_MODEL,
} from "./embedding-provider.js";
import { DEEPINFRA_BASE_URL, type DeepInfraSurfaceModel } from "./provider-models.js";

const EXCLUDED_EMBEDDING_HEADERS = ["authorization", "content-type", "x-api-key", "api-key"];

function textFromEmbeddingInput(input: EmbeddingInput): string {
  return typeof input === "string" ? input : input.text;
}

function adaptMemoryEmbeddingProvider(provider: MemoryEmbeddingProvider): EmbeddingProvider {
  return {
    id: provider.id,
    model: provider.model,
    ...(typeof provider.maxInputTokens === "number"
      ? { maxInputTokens: provider.maxInputTokens }
      : {}),
    embed: async (input, options) =>
      await provider.embedQuery(textFromEmbeddingInput(input), { signal: options?.signal }),
    embedBatch: async (inputs, options) =>
      await provider.embedBatch(inputs.map(textFromEmbeddingInput), { signal: options?.signal }),
    ...(provider.close ? { close: async () => await provider.close?.() } : {}),
  };
}

// First entry of embedModels becomes the default embedding model.
export function buildDeepInfraEmbeddingAdapter(options?: {
  embedModels?: readonly DeepInfraSurfaceModel[];
}): EmbeddingProviderAdapter {
  const defaultModel = options?.embedModels?.[0]?.id ?? DEFAULT_DEEPINFRA_EMBEDDING_MODEL;
  return {
    id: "deepinfra",
    defaultModel,
    transport: "remote",
    authProviderId: "deepinfra",
    create: async (createOptions) => {
      const { dimensions, ...memoryOptions } = createOptions;
      const { provider, client } = await createDeepInfraEmbeddingProvider({
        ...memoryOptions,
        provider: "deepinfra",
        fallback: "none",
        outputDimensionality: dimensions,
        taskType: createOptions.taskType as MemoryEmbeddingProviderCreateOptions["taskType"],
        defaultModel,
      });
      const headers = sanitizeEmbeddingCacheHeaders(client.headers, EXCLUDED_EMBEDDING_HEADERS);
      const usesDefaultIdentity =
        headers.length === 0 &&
        embeddingProviderOwnsDestination({
          baseUrl: client.baseUrl,
          providerBaseUrl: DEEPINFRA_BASE_URL,
        });
      return {
        provider: provider ? adaptMemoryEmbeddingProvider(provider) : null,
        runtime: {
          id: "deepinfra",
          cacheKeyData: {
            provider: "deepinfra",
            model: client.model,
            ...(usesDefaultIdentity ? {} : { baseUrl: client.baseUrl, headers }),
          },
        },
      };
    },
  };
}

export const deepinfraEmbeddingProviderAdapter: EmbeddingProviderAdapter =
  buildDeepInfraEmbeddingAdapter();
