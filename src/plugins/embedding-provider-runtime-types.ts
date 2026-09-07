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

/** Provider-owned asynchronous batching capability, independent of host runtime metadata. */
export type EmbeddingProviderBatchRuntime = {
  /** Returns one vector per chunk in input order, or null to use host fallback. */
  batchEmbed: (options: EmbeddingBatchOptions) => Promise<number[][] | null>;
  /** Only true enables batching across dirty files; false or omission retains per-file batches. */
  sourceWideBatchEmbed?: boolean;
};
