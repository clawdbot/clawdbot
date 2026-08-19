import type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
} from "./embedding-provider-types.js";
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateOptions,
} from "./registry-contribution-types.js";

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");

export type {
  MemoryEmbeddingBatchChunk,
  MemoryEmbeddingBatchOptions,
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCallOptions,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderCreateResult,
  MemoryEmbeddingProviderIndexIdentity,
  MemoryEmbeddingProviderRuntime,
} from "./registry-contribution-types.js";

function embeddingInputText(input: EmbeddingInput): string {
  return typeof input === "string" ? input : input.text;
}

function memoryCreateOptions(
  options: EmbeddingProviderCreateOptions,
): Parameters<MemoryEmbeddingProviderAdapter["create"]>[0] {
  // Runtime callers may carry memory-owner extensions such as acquireLocalService.
  // Preserve them while translating the two fields renamed by the generic contract.
  const { dimensions, taskType, ...base } = options;
  return {
    ...base,
    fallback: "none",
    ...(typeof dimensions === "number" ? { outputDimensionality: dimensions } : {}),
    taskType: taskType as MemoryEmbeddingProviderCreateOptions["taskType"],
  };
}

type MemoryEmbeddingInput = Parameters<
  NonNullable<MemoryEmbeddingProvider["embedBatchInputs"]>
>[0][number];

function memoryEmbeddingInput(input: EmbeddingInput): MemoryEmbeddingInput {
  return typeof input === "string" ? { text: input } : input;
}

function adaptMemoryEmbeddingProvider(provider: MemoryEmbeddingProvider): EmbeddingProvider {
  const embedBatch = async (
    inputs: EmbeddingInput[],
    options?: EmbeddingProviderCallOptions,
  ): Promise<number[][]> => {
    if (options?.inputType === "query") {
      return await Promise.all(
        inputs.map((input) => provider.embedQuery(embeddingInputText(input), options)),
      );
    }
    if (provider.embedBatchInputs) {
      return await provider.embedBatchInputs(inputs.map(memoryEmbeddingInput), options);
    }
    return await provider.embedBatch(inputs.map(embeddingInputText), options);
  };

  const adapted: EmbeddingProvider = {
    id: provider.id,
    model: provider.model,
    ...(typeof provider.maxInputTokens === "number"
      ? { maxInputTokens: provider.maxInputTokens }
      : {}),
    embed: async (input, options) => {
      if (options?.inputType === "query") {
        return await provider.embedQuery(embeddingInputText(input), options);
      }
      return (await embedBatch([input], options))[0] ?? [];
    },
    embedBatch,
    ...(provider.close ? { close: async () => await provider.close?.() } : {}),
  };
  const getRuntimeFacts = Reflect.get(provider, LOCAL_EMBEDDING_RUNTIME_FACTS);
  if (typeof getRuntimeFacts === "function") {
    Object.defineProperty(adapted, LOCAL_EMBEDDING_RUNTIME_FACTS, {
      enumerable: false,
      value: getRuntimeFacts,
    });
  }
  return adapted;
}

/** Adapt a memory-aware provider implementation to the generic registration contract. */
export function adaptMemoryEmbeddingProviderAdapter(
  adapter: MemoryEmbeddingProviderAdapter,
): EmbeddingProviderAdapter {
  const { create: _create, resolveIndexIdentity, ...metadata } = adapter;
  return {
    ...metadata,
    ...(resolveIndexIdentity
      ? {
          resolveIndexIdentity: (options: EmbeddingProviderCreateOptions) =>
            resolveIndexIdentity(memoryCreateOptions(options)),
        }
      : {}),
    create: async (options) => {
      const result = await adapter.create(memoryCreateOptions(options));
      return {
        ...result,
        provider: result.provider ? adaptMemoryEmbeddingProvider(result.provider) : null,
      };
    },
  };
}
