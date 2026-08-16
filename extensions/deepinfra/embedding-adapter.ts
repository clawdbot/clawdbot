// Deepinfra plugin module adapts its text embedding runtime to the generic provider contract.
import type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/embedding-providers";
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createDeepInfraEmbeddingProvider,
  DEFAULT_DEEPINFRA_EMBEDDING_MODEL,
} from "./embedding-provider.js";
import type { DeepInfraSurfaceModel } from "./provider-models.js";

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

function buildMemoryCreateOptions(
  options: EmbeddingProviderCreateOptions,
): MemoryEmbeddingProviderCreateOptions {
  return {
    config: options.config,
    agentDir: options.agentDir,
    provider: "deepinfra",
    fallback: "none",
    remote: options.remote,
    model: options.model,
    inputType: options.inputType,
    queryInputType: options.queryInputType,
    documentInputType: options.documentInputType,
    outputDimensionality: options.dimensions,
    taskType: options.taskType as MemoryEmbeddingProviderCreateOptions["taskType"],
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
      const { provider, client } = await createDeepInfraEmbeddingProvider({
        ...buildMemoryCreateOptions(createOptions),
        defaultModel,
      });
      return {
        provider: provider ? adaptMemoryEmbeddingProvider(provider) : null,
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

export const deepinfraEmbeddingProviderAdapter: EmbeddingProviderAdapter =
  buildDeepInfraEmbeddingAdapter();
