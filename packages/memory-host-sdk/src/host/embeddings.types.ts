// Memory Host SDK type module defines shared TypeScript contracts.
import type { OpenClawConfig, SecretInput } from "../engine-foundation.js";
import type { EmbeddingInput } from "./embedding-inputs.js";

export type EmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string, options?: EmbeddingProviderCallOptions) => Promise<number[]>;
  embedBatch: (texts: string[], options?: EmbeddingProviderCallOptions) => Promise<number[][]>;
  embedBatchInputs?: (
    inputs: EmbeddingInput[],
    options?: EmbeddingProviderCallOptions,
  ) => Promise<number[][]>;
  close?: () => Promise<void> | void;
};

export type EmbeddingProviderCallOptions = {
  signal?: AbortSignal;
};

/** @public */ export type EmbeddingProviderId = string;
/** @public */ export type EmbeddingProviderRequest = string;
/** @public */ export type EmbeddingProviderFallback = string;

/** @public */ export type GeminiTaskType =
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
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
  fallback?: EmbeddingProviderFallback;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
  /** Provider-specific output vector dimensions for supported embedding families. */
  outputDimensionality?: number;
  /** Gemini: override the default task type sent with embedding requests. */
  taskType?: GeminiTaskType;
};
