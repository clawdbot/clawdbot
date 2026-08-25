/** One text chunk submitted through a provider-owned asynchronous embedding batch. */
export type EmbeddingBatchChunk = {
  text: string;
};

/** Host-controlled execution parameters for an asynchronous embedding batch. */
export type EmbeddingBatchOptions = {
  agentId: string;
  chunks: EmbeddingBatchChunk[];
  wait: boolean;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
  debug: (message: string, data?: Record<string, unknown>) => void;
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
  /** Lets the provider batch chunks from multiple dirty memory files in one request. */
  sourceWideBatchEmbed?: boolean;
  /** Runs the provider-owned asynchronous batch lifecycle, returning one vector per chunk. */
  batchEmbed?: (options: EmbeddingBatchOptions) => Promise<number[][] | null>;
};
