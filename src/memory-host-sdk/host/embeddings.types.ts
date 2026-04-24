import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SecretInput } from "../../config/types.secrets.js";
import type { EmbeddingInput } from "./embedding-inputs.js";

export type EmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
  embedBatchInputs?: (inputs: EmbeddingInput[]) => Promise<number[][]>;
};

export type EmbeddingProviderId = string;
export type EmbeddingProviderRequest = string;
export type EmbeddingProviderFallback = string;

export type GeminiTaskType =
  | "RETRIEVAL_QUERY"
  | "RETRIEVAL_DOCUMENT"
  | "SEMANTIC_SIMILARITY"
  | "CLASSIFICATION"
  | "CLUSTERING"
  | "QUESTION_ANSWERING"
  | "FACT_VERIFICATION";

export type EmbeddingProviderOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  provider?: EmbeddingProviderRequest;
  remote?: {
    baseUrl?: string;
    apiKey?: SecretInput;
    headers?: Record<string, string>;
  };
  model: string;
  fallback?: EmbeddingProviderFallback;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
    /**
     * Context size passed to node-llama-cpp `createEmbeddingContext`.
     * Default: 4096, chosen to cover typical memory-search chunks (128–512 tokens)
     * while keeping non-weight VRAM bounded.
     * Set `"auto"` to let node-llama-cpp use the model's trained maximum — not
     * recommended for 8B+ models (e.g. Qwen3-Embedding-8B: up to 40 960 tokens → ~32 GB VRAM).
     */
    contextSize?: number | "auto";
  };
  /** Provider-specific output vector dimensions for supported embedding families. */
  outputDimensionality?: number;
  /** Gemini: override the default task type sent with embedding requests. */
  taskType?: GeminiTaskType;
};
