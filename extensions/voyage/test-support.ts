import type { VoyageEmbeddingClient } from "./embedding-provider.js";

type VoyageBatchTestParams = {
  client: VoyageEmbeddingClient;
  deps: Record<string, unknown>;
  maxResponseBytes?: number;
};

type VoyageEmbeddingBatchTestApi = {
  fetchVoyageBatchStatus: (params: VoyageBatchTestParams & { batchId: string }) => Promise<unknown>;
  readVoyageBatchError: (
    params: VoyageBatchTestParams & { errorFileId: string },
  ) => Promise<string | undefined>;
  VOYAGE_BATCH_RESPONSE_MAX_BYTES: number;
};

const api = Reflect.get(globalThis, Symbol.for("openclaw.voyageEmbeddingBatchTestApi"));
if (!api) {
  throw new Error("Voyage embedding batch test API is unavailable");
}

export const voyageEmbeddingBatchTesting = api as VoyageEmbeddingBatchTestApi;
