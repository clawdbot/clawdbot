import type { OpenClawConfig } from "../config/config.js";

export type { EmbeddingInput } from "../memory/embedding-inputs.js";
export { hasNonTextEmbeddingParts } from "../memory/embedding-inputs.js";
export { enforceEmbeddingMaxInputTokens } from "../memory/embedding-chunk-limits.js";
export {
  runGeminiEmbeddingBatches,
  type GeminiBatchRequest,
} from "../memory/batch-gemini.js";
export {
  runOpenAiEmbeddingBatches,
  OPENAI_BATCH_ENDPOINT,
  type OpenAiBatchRequest,
} from "../memory/batch-openai.js";
export {
  runVoyageEmbeddingBatches,
  type VoyageBatchRequest,
} from "../memory/batch-voyage.js";
export {
  buildGeminiEmbeddingRequest,
  createGeminiEmbeddingProvider,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  type GeminiEmbeddingClient,
} from "../memory/embeddings-gemini.js";
export {
  createMistralEmbeddingProvider,
  DEFAULT_MISTRAL_EMBEDDING_MODEL,
  type MistralEmbeddingClient,
} from "../memory/embeddings-mistral.js";
export {
  createOllamaEmbeddingProvider,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  type OllamaEmbeddingClient,
} from "../memory/embeddings-ollama.js";
export {
  createOpenAiEmbeddingProvider,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  type OpenAiEmbeddingClient,
} from "../memory/embeddings-openai.js";
export {
  createVoyageEmbeddingProvider,
  DEFAULT_VOYAGE_EMBEDDING_MODEL,
  type VoyageEmbeddingClient,
} from "../memory/embeddings-voyage.js";
export {
  DEFAULT_LOCAL_MODEL,
  type EmbeddingProvider as MemoryEmbeddingProvider,
} from "../memory/embeddings.js";
export {
  classifyMemoryMultimodalPath,
  getMemoryMultimodalExtensions,
  buildCaseInsensitiveExtensionGlob,
} from "../memory/multimodal.js";

export const DEFAULT_LMSTUDIO_EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";

export type MemoryEmbeddingProviderRuntime = {
  id: string;
  cacheKeyData?: Record<string, unknown>;
  batchEmbed?: (params: {
    agentId: string;
    chunks: Array<{
      text: string;
      embeddingInput?: import("../memory/embedding-inputs.js").EmbeddingInput;
    }>;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    debug?: (message: string, data?: Record<string, unknown>) => void;
  }) => Promise<number[][] | null>;
};

export type MemoryEmbeddingProviderCreateOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  remote?: {
    baseUrl?: string;
    apiKey?: unknown;
    headers?: Record<string, string>;
  };
  model: string;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
  outputDimensionality?: number;
};

export type MemoryEmbeddingProvider = {
  id: string;
  model: string;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
  embedBatchInputs?: (
    inputs: import("../memory/embedding-inputs.js").EmbeddingInput[],
  ) => Promise<number[][]>;
};

export type MemoryEmbeddingProviderAdapter = {
  id: string;
  defaultModel?: string;
  transport?: "local" | "remote";
  autoSelectPriority?: number;
  allowExplicitWhenConfiguredAuto?: boolean;
  supportsMultimodalEmbeddings?: (params: { model: string }) => boolean;
  shouldContinueAutoSelection?: (err: unknown) => boolean;
  formatSetupError?: (err: unknown) => string;
  create: (
    options: MemoryEmbeddingProviderCreateOptions,
  ) => Promise<{ provider: MemoryEmbeddingProvider; runtime?: MemoryEmbeddingProviderRuntime }>;
};

const MEMORY_PROVIDER_ADAPTERS_KEY = Symbol.for("openclaw.memoryEmbeddingProviderAdapters");

function resolveRegistry(): Map<string, MemoryEmbeddingProviderAdapter> {
  const root = globalThis as typeof globalThis & {
    [MEMORY_PROVIDER_ADAPTERS_KEY]?: Map<string, MemoryEmbeddingProviderAdapter>;
  };
  root[MEMORY_PROVIDER_ADAPTERS_KEY] ??= new Map<string, MemoryEmbeddingProviderAdapter>();
  return root[MEMORY_PROVIDER_ADAPTERS_KEY];
}

export function registerMemoryEmbeddingProviderAdapter(
  adapter: MemoryEmbeddingProviderAdapter,
): void {
  resolveRegistry().set(adapter.id, adapter);
}

export function listRegisteredMemoryEmbeddingProviderAdapters(): MemoryEmbeddingProviderAdapter[] {
  return [...resolveRegistry().values()];
}

export function getMemoryEmbeddingProvider(
  id: string,
  _config?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter | undefined {
  return resolveRegistry().get(id);
}

export function listMemoryEmbeddingProviders(
  _config?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter[] {
  return listRegisteredMemoryEmbeddingProviderAdapters();
}
