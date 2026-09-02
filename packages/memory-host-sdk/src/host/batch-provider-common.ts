// Memory Host SDK helper module supports batch provider common behavior.
import type { EmbeddingBatchOutputLine } from "./batch-output.js";

// Common OpenAI-compatible batch shapes shared by remote embedding providers.

/** Minimal provider batch status payload used by polling code. */
export type EmbeddingBatchStatus = {
  id?: string;
  status?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
};

/** Provider output line after an embedding batch file is read. */
export type ProviderBatchOutputLine = EmbeddingBatchOutputLine;

/** OpenAI-compatible endpoint used inside embedding batch request lines. */
export const EMBEDDING_BATCH_ENDPOINT = "/v1/embeddings";
