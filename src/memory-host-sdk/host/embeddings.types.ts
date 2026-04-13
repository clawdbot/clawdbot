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

export type EmbeddingProviderId =
  | "openai"
  | "local"
  | "gemini"
  | "voyage"
  | "mistral"
  | "lmstudio"
  | "ollama"
  | "bedrock";

export type EmbeddingProviderRequest = EmbeddingProviderId | "auto";
export type EmbeddingProviderFallback = EmbeddingProviderId | "none";

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
  provider: EmbeddingProviderRequest;
  remote?: {
    baseUrl?: string;
    apiKey?: SecretInput;
    headers?: Record<string, string>;
  };
  model: string;
  fallback: EmbeddingProviderFallback;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
  /** Provider-specific output vector dimensions for supported embedding families. */
  outputDimensionality?: number;
  /** Gemini: override the default task type sent with embedding requests. */
  taskType?: GeminiTaskType;
};
