// Resolves plugin-provided memory embedding providers from config and registry.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import type { EmbeddingInput } from "../memory-host-sdk/host/embedding-inputs.js";

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
export type MemoryEmbeddingProviderCallOptions = {
  signal?: AbortSignal;
};

/** Runtime metadata returned with memory embedding providers. */
export type MemoryEmbeddingProviderRuntime = {
  id: string;
  cacheKeyData?: Record<string, unknown>;
  inlineQueryTimeoutMs?: number;
  inlineBatchTimeoutMs?: number;
  batchEmbed?: (options: MemoryEmbeddingBatchOptions) => Promise<number[][] | null>;
};

/** Created memory embedding provider instance. */
export type MemoryEmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string, options?: MemoryEmbeddingProviderCallOptions) => Promise<number[]>;
  embedBatch: (
    texts: string[],
    options?: MemoryEmbeddingProviderCallOptions,
  ) => Promise<number[][]>;
  embedBatchInputs?: (
    inputs: EmbeddingInput[],
    options?: MemoryEmbeddingProviderCallOptions,
  ) => Promise<number[][]>;
  close?: () => Promise<void> | void;
};

/** Options passed to memory embedding provider adapters. */
export type MemoryEmbeddingProviderCreateOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  provider?: string;
  fallback?: string;
  remote?: {
    baseUrl?: string;
    apiKey?: SecretInput;
    headers?: Record<string, string>;
  };
  model: string;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
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
export type MemoryEmbeddingProviderAdapter = {
  id: string;
  defaultModel?: string;
  transport?: "local" | "remote";
  authProviderId?: string;
  autoSelectPriority?: number;
  allowExplicitWhenConfiguredAuto?: boolean;
  supportsMultimodalEmbeddings?: (params: { model: string }) => boolean;
  create: (
    options: MemoryEmbeddingProviderCreateOptions,
  ) => Promise<MemoryEmbeddingProviderCreateResult>;
  formatSetupError?: (err: unknown) => string;
  shouldContinueAutoSelection?: (err: unknown) => boolean;
};

/** Registered memory embedding provider with optional owning plugin metadata. */
export type RegisteredMemoryEmbeddingProvider = {
  adapter: MemoryEmbeddingProviderAdapter;
  ownerPluginId?: string;
};

const MEMORY_EMBEDDING_PROVIDERS_KEY = Symbol.for("openclaw.memoryEmbeddingProviders");

function getMemoryEmbeddingProviders(): Map<string, RegisteredMemoryEmbeddingProvider> {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[MEMORY_EMBEDDING_PROVIDERS_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, RegisteredMemoryEmbeddingProvider>;
  }
  const created = new Map<string, RegisteredMemoryEmbeddingProvider>();
  globalStore[MEMORY_EMBEDDING_PROVIDERS_KEY] = created;
  return created;
}

/** Registers a memory embedding provider adapter for the current process. */
export function registerMemoryEmbeddingProvider(
  adapter: MemoryEmbeddingProviderAdapter,
  options?: { ownerPluginId?: string },
): void {
  getMemoryEmbeddingProviders().set(adapter.id, {
    adapter,
    ownerPluginId: options?.ownerPluginId,
  });
}

/** Returns a registered memory embedding provider entry. */
export function getRegisteredMemoryEmbeddingProvider(
  id: string,
): RegisteredMemoryEmbeddingProvider | undefined {
  return getMemoryEmbeddingProviders().get(id);
}

/** Returns only the memory embedding provider adapter. */
export function getMemoryEmbeddingProvider(id: string): MemoryEmbeddingProviderAdapter | undefined {
  return getMemoryEmbeddingProviders().get(id)?.adapter;
}

/** Lists registered memory embedding provider entries. */
export function listRegisteredMemoryEmbeddingProviders(): RegisteredMemoryEmbeddingProvider[] {
  return Array.from(getMemoryEmbeddingProviders().values());
}

/** Lists registered memory embedding provider adapters. */
export function listMemoryEmbeddingProviders(): MemoryEmbeddingProviderAdapter[] {
  return listRegisteredMemoryEmbeddingProviders().map((entry) => entry.adapter);
}

/** Replaces registered memory embedding providers with adapter-only state. */
export function restoreMemoryEmbeddingProviders(adapters: MemoryEmbeddingProviderAdapter[]): void {
  getMemoryEmbeddingProviders().clear();
  for (const adapter of adapters) {
    registerMemoryEmbeddingProvider(adapter);
  }
}

/** Replaces registered memory embedding providers while preserving metadata. */
export function restoreRegisteredMemoryEmbeddingProviders(
  entries: RegisteredMemoryEmbeddingProvider[],
): void {
  getMemoryEmbeddingProviders().clear();
  for (const entry of entries) {
    registerMemoryEmbeddingProvider(entry.adapter, {
      ownerPluginId: entry.ownerPluginId,
    });
  }
}

/** Clears registered memory embedding providers. */
export function clearMemoryEmbeddingProviders(): void {
  getMemoryEmbeddingProviders().clear();
}

export const resetMemoryEmbeddingProviders = clearMemoryEmbeddingProviders;
