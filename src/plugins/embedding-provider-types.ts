/** Type contracts for plugin-contributed embedding providers. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";

/** Input accepted by embedding providers, including multimodal inline-data parts. */
export type EmbeddingInput =
  | string
  | {
      text: string;
      parts?: Array<
        { type: "text"; text: string } | { type: "inline-data"; mimeType: string; data: string }
      >;
    };

/** Per-call options passed to embedding provider calls. */
export type EmbeddingProviderCallOptions = {
  signal?: AbortSignal;
  inputType?: "query" | "document" | "semantic" | "classification" | "clustering";
};

/** Runtime metadata returned with a created embedding provider. */
export type EmbeddingProviderRuntime = {
  id: string;
  cacheKeyData?: Record<string, unknown>;
  /** Prior persisted model/cache identities that are equivalent to the current identity. */
  indexIdentityAliases?: Array<{
    model: string;
    cacheKeyData: Record<string, unknown>;
  }>;
  inlineQueryTimeoutMs?: number;
  inlineBatchTimeoutMs?: number;
};

/** Provider-owned canonical identity and exact aliases for persisted indexes. */
export type EmbeddingProviderIndexIdentity = {
  model: string;
  cacheKeyData: Record<string, unknown>;
  aliases?: Array<{
    model: string;
    cacheKeyData: Record<string, unknown>;
  }>;
};

/** Created embedding provider instance used by memory/search callers. */
export type EmbeddingProvider = {
  id: string;
  model: string;
  dimensions?: number;
  maxInputTokens?: number;
  embed: (input: EmbeddingInput, options?: EmbeddingProviderCallOptions) => Promise<number[]>;
  embedBatch: (
    inputs: EmbeddingInput[],
    options?: EmbeddingProviderCallOptions,
  ) => Promise<number[][]>;
  close?: () => Promise<void> | void;
};

/** Options passed to embedding provider adapters when creating providers. */
export type EmbeddingProviderCreateOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  provider?: string;
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
  };
  dimensions?: number;
  taskType?: string;
};

/** Result returned by an embedding provider adapter create call. */
export type EmbeddingProviderCreateResult = {
  provider: EmbeddingProvider | null;
  runtime?: EmbeddingProviderRuntime;
};

/** Adapter contract registered by core or plugin embedding providers. */
export type EmbeddingProviderAdapter = {
  id: string;
  defaultModel?: string;
  transport?: "local" | "remote";
  authProviderId?: string;
  resolveIndexIdentity?: (
    options: EmbeddingProviderCreateOptions,
  ) => EmbeddingProviderIndexIdentity;
  create: (options: EmbeddingProviderCreateOptions) => Promise<EmbeddingProviderCreateResult>;
  formatSetupError?: (err: unknown) => string;
};

/** Registered embedding provider with optional owning plugin metadata. */
export type RegisteredEmbeddingProvider = {
  adapter: EmbeddingProviderAdapter;
  ownerPluginId?: string;
};
