// Runtime bridge for plugin-provided memory embedding providers.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getEmbeddingProvider, listEmbeddingProviders } from "./embedding-provider-runtime.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCreateOptions,
} from "./embedding-provider-types.js";
import { listRegisteredEmbeddingProviders } from "./embedding-providers.js";
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateOptions,
} from "./memory-embedding-providers.js";

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");

/** Lists registered memory embedding provider adapters without registry metadata. */
export function listRegisteredMemoryEmbeddingProviderAdapters(): MemoryEmbeddingProviderAdapter[] {
  return listRegisteredEmbeddingProviders().map((entry) =>
    adaptEmbeddingProviderAdapter(entry.adapter),
  );
}

/** Lists memory embedding providers from runtime config and registered adapters. */
export function listMemoryEmbeddingProviders(
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter[] {
  return listEmbeddingProviders(cfg).map(adaptEmbeddingProviderAdapter);
}

function adaptEmbeddingProvider(provider: EmbeddingProvider): MemoryEmbeddingProvider {
  const adapted: MemoryEmbeddingProvider = {
    ...provider,
    embedQuery: (text, options) => provider.embed(text, { ...options, inputType: "query" }),
    embedBatch: (texts, options) =>
      provider.embedBatch(texts, { ...options, inputType: "document" }),
    embedBatchInputs: (inputs, options) =>
      provider.embedBatch(inputs, { ...options, inputType: "document" }),
    ...(provider.close ? { close: () => provider.close?.() } : {}),
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

function adaptEmbeddingProviderAdapter(
  adapter: EmbeddingProviderAdapter,
): MemoryEmbeddingProviderAdapter {
  const genericOptions = (
    options: MemoryEmbeddingProviderCreateOptions,
  ): EmbeddingProviderCreateOptions => ({
    ...options,
    ...(typeof options.outputDimensionality === "number"
      ? { dimensions: options.outputDimensionality }
      : {}),
  });
  const resolveIndexIdentity = adapter.resolveIndexIdentity;

  return {
    ...adapter,
    ...(resolveIndexIdentity
      ? {
          resolveIndexIdentity: (options) => resolveIndexIdentity(genericOptions(options)),
        }
      : {}),
    create: async (options) => {
      const result = await adapter.create(genericOptions(options));
      return {
        ...result,
        provider: result.provider ? adaptEmbeddingProvider(result.provider) : null,
      };
    },
  };
}

/** Resolves one memory embedding provider by id, alias, or configured API owner. */
export function getMemoryEmbeddingProvider(
  id: string,
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter | undefined {
  const embeddingAdapter = getEmbeddingProvider(id, cfg);
  return embeddingAdapter ? adaptEmbeddingProviderAdapter(embeddingAdapter) : undefined;
}
