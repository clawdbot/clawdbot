import type { EmbeddingInput } from "../../packages/memory-host-sdk/src/engine-embeddings.js";
// Resolves plugin-provided memory embedding providers from config and registry.
import type {
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderIndexIdentity,
  EmbeddingProviderRuntime,
} from "./embedding-provider-types.js";
import {
  assertDirectPluginRegistrationReplacement,
  requireActivePluginRegistry,
  resolveDirectPluginRegistrationOwner,
} from "./runtime.js";

/** Chunk submitted to memory embedding batch processing. */
export type MemoryEmbeddingBatchChunk = {
  text: string;
  embeddingInput?: EmbeddingInput;
};

/** Options for batch memory embedding work. */
export type MemoryEmbeddingBatchOptions = {
  agentId: string;
  chunks: MemoryEmbeddingBatchChunk[];
  wait: boolean;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
  debug: (message: string, data?: Record<string, unknown>) => void;
};

/** Per-call options for memory embedding providers. */
export type MemoryEmbeddingProviderCallOptions = Pick<EmbeddingProviderCallOptions, "signal">;

/** Runtime metadata returned with memory embedding providers. */
export type MemoryEmbeddingProviderRuntime = EmbeddingProviderRuntime & {
  sourceWideBatchEmbed?: boolean;
  batchEmbed?: (options: MemoryEmbeddingBatchOptions) => Promise<number[][] | null>;
};

/** Provider-owned canonical identity and exact aliases for persisted indexes. */
export type MemoryEmbeddingProviderIndexIdentity = EmbeddingProviderIndexIdentity;

/** Created memory embedding provider instance. */
export type MemoryEmbeddingProvider = Pick<
  EmbeddingProvider,
  "id" | "model" | "maxInputTokens" | "close"
> & {
  embedQuery: (text: string, options?: MemoryEmbeddingProviderCallOptions) => Promise<number[]>;
  embedBatch: (
    texts: string[],
    options?: MemoryEmbeddingProviderCallOptions,
  ) => Promise<number[][]>;
  embedBatchInputs?: (
    inputs: EmbeddingInput[],
    options?: MemoryEmbeddingProviderCallOptions,
  ) => Promise<number[][]>;
};

/** Options passed to memory embedding provider adapters. */
export type MemoryEmbeddingProviderCreateOptions = Omit<
  EmbeddingProviderCreateOptions,
  "dimensions" | "local" | "taskType"
> & {
  fallback?: string;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
    contextSize?: number | "auto";
  };
  outputDimensionality?: number;
  taskType?:
    | "RETRIEVAL_QUERY"
    | "RETRIEVAL_DOCUMENT"
    | "SEMANTIC_SIMILARITY"
    | "CLASSIFICATION"
    | "CLUSTERING"
    | "QUESTION_ANSWERING"
    | "FACT_VERIFICATION";
};

/** Result returned by a memory embedding provider adapter. */
export type MemoryEmbeddingProviderCreateResult = {
  provider: MemoryEmbeddingProvider | null;
  runtime?: MemoryEmbeddingProviderRuntime;
};

/** Adapter contract for registered memory embedding providers. */
export type MemoryEmbeddingProviderAdapter = Omit<
  EmbeddingProviderAdapter,
  "create" | "resolveIndexIdentity"
> & {
  autoSelectPriority?: number;
  allowExplicitWhenConfiguredAuto?: boolean;
  supportsMultimodalEmbeddings?: (params: { model: string }) => boolean;
  resolveIndexIdentity?: (
    options: MemoryEmbeddingProviderCreateOptions,
  ) => MemoryEmbeddingProviderIndexIdentity;
  create: (
    options: MemoryEmbeddingProviderCreateOptions,
  ) => Promise<MemoryEmbeddingProviderCreateResult>;
  shouldContinueAutoSelection?: (err: unknown) => boolean;
};

/** Registered memory embedding provider with optional owning plugin metadata. */
export type RegisteredMemoryEmbeddingProvider = {
  adapter: MemoryEmbeddingProviderAdapter;
  ownerPluginId?: string;
};

function getMemoryEmbeddingProviders(): RegisteredMemoryEmbeddingProvider[] {
  return requireActivePluginRegistry().memoryEmbeddingProviders.map((entry) => ({
    adapter: entry.provider,
    ownerPluginId: entry.pluginId || undefined,
  }));
}

/** Registers a memory embedding provider adapter for the current process. */
export function registerMemoryEmbeddingProvider(
  adapter: MemoryEmbeddingProviderAdapter,
  options?: { ownerPluginId?: string },
): void {
  const registry = requireActivePluginRegistry();
  const pluginId = resolveDirectPluginRegistrationOwner(options?.ownerPluginId) ?? "";
  const entry = {
    pluginId,
    provider: adapter,
    source: "runtime",
  };
  const index = registry.memoryEmbeddingProviders.findIndex(
    (registration) => registration.provider.id === adapter.id,
  );
  if (index !== -1) {
    assertDirectPluginRegistrationReplacement(
      registry.memoryEmbeddingProviders[index]?.pluginId || undefined,
      `memory embedding provider ${adapter.id}`,
    );
  }
  index === -1
    ? registry.memoryEmbeddingProviders.push(entry)
    : registry.memoryEmbeddingProviders.splice(index, 1, entry);
}

/** Returns a registered memory embedding provider entry. */
export function getRegisteredMemoryEmbeddingProvider(
  id: string,
): RegisteredMemoryEmbeddingProvider | undefined {
  return getMemoryEmbeddingProviders().find((entry) => entry.adapter.id === id);
}

/** Lists registered memory embedding provider entries. */
export function listRegisteredMemoryEmbeddingProviders(): RegisteredMemoryEmbeddingProvider[] {
  return getMemoryEmbeddingProviders();
}

/** Lists registered memory embedding provider adapters. */
export function listMemoryEmbeddingProviders(): MemoryEmbeddingProviderAdapter[] {
  return listRegisteredMemoryEmbeddingProviders().map((entry) => entry.adapter);
}
/** Replaces registered memory embedding providers while preserving metadata. */
export function restoreRegisteredMemoryEmbeddingProviders(
  entries: RegisteredMemoryEmbeddingProvider[],
): void {
  clearMemoryEmbeddingProviders();
  for (const entry of entries) {
    registerMemoryEmbeddingProvider(entry.adapter, {
      ownerPluginId: entry.ownerPluginId,
    });
  }
}

/** Clears registered memory embedding providers. */
export function clearMemoryEmbeddingProviders(): void {
  requireActivePluginRegistry().memoryEmbeddingProviders.length = 0;
}
