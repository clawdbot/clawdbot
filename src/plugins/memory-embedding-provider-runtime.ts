// Runtime bridge for plugin-provided memory embedding providers.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readConfiguredProviderApiId } from "./embedding-provider-config.js";
import {
  getRuntimeEmbeddingProviderAdapter,
  listRuntimeEmbeddingProviderAdapters,
  resolveRuntimeEmbeddingProviderLookupIds,
} from "./embedding-provider-runtime-shared.js";
import { getEmbeddingProvider } from "./embedding-provider-runtime.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCreateOptions,
} from "./embedding-provider-types.js";
import {
  getRegisteredMemoryEmbeddingProvider,
  listRegisteredMemoryEmbeddingProviders,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderAdapter,
  type MemoryEmbeddingProviderCreateOptions,
} from "./memory-embedding-providers.js";

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");

export { listRegisteredMemoryEmbeddingProviders };

/** Lists registered memory embedding provider adapters without registry metadata. */
export function listRegisteredMemoryEmbeddingProviderAdapters(): MemoryEmbeddingProviderAdapter[] {
  return listRegisteredMemoryEmbeddingProviders().map((entry) => entry.adapter);
}

/** Lists memory embedding providers from runtime config and registered adapters. */
export function listMemoryEmbeddingProviders(
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter[] {
  return listRuntimeEmbeddingProviderAdapters({
    key: "memoryEmbeddingProviders",
    cfg,
    registered: listRegisteredMemoryEmbeddingProviderAdapters(),
  });
}

function resolveConfiguredMemoryEmbeddingProviderId(
  providerId: string,
  cfg?: OpenClawConfig,
): string | undefined {
  return readConfiguredProviderApiId({ providerId, cfg });
}

function resolveMemoryEmbeddingProviderLookupIds(id: string, cfg?: OpenClawConfig): string[] {
  return resolveRuntimeEmbeddingProviderLookupIds({
    id,
    cfg,
    resolveConfiguredProviderId: resolveConfiguredMemoryEmbeddingProviderId,
  });
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
  const memoryAdapter = getRuntimeEmbeddingProviderAdapter({
    key: "memoryEmbeddingProviders",
    cfg,
    lookupIds: resolveMemoryEmbeddingProviderLookupIds(id, cfg),
    getRegisteredProvider: getRegisteredMemoryEmbeddingProvider,
  });
  if (memoryAdapter) {
    return memoryAdapter;
  }

  // Resolve the shipped generic provider contract at its registry owner so all
  // memory consumers share one query/document and multimodal adaptation path.
  const embeddingAdapter = getEmbeddingProvider(id, cfg);
  return embeddingAdapter ? adaptEmbeddingProviderAdapter(embeddingAdapter) : undefined;
}
