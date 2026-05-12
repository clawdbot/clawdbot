import type { MemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOpenAiEmbeddingProvider: vi.fn(),
  runOpenAiEmbeddingBatches: vi.fn(async () => new Map([["0", [1, 0]]])),
}));

vi.mock("./embedding-provider.js", () => ({
  DEFAULT_OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
  createOpenAiEmbeddingProvider: mocks.createOpenAiEmbeddingProvider,
}));

vi.mock("./embedding-batch.js", () => ({
  OPENAI_BATCH_ENDPOINT: "/v1/embeddings",
  runOpenAiEmbeddingBatches: mocks.runOpenAiEmbeddingBatches,
}));

import { openAiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

const provider: MemoryEmbeddingProvider = {
  id: "openai",
  model: "text-embedding-3-small",
  embedQuery: async () => [1, 0],
  embedBatch: async (texts) => texts.map(() => [1, 0]),
};

describe("OpenAI memory embedding adapter", () => {
  beforeEach(() => {
    mocks.createOpenAiEmbeddingProvider.mockReset();
    mocks.runOpenAiEmbeddingBatches.mockClear();
    mocks.createOpenAiEmbeddingProvider.mockResolvedValue({
      provider,
      client: {
        baseUrl: "https://embeddings.example/v1",
        headers: {},
        model: "text-embedding-3-small",
        inputType: "passage",
        documentInputType: "document",
        outputDimensionality: 512,
      },
    });
  });

  it("sends document input_type in OpenAI batch embedding requests", async () => {
    const result = await openAiMemoryEmbeddingProviderAdapter.create({
      config: {} as never,
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "none",
    });

    await result.runtime?.batchEmbed?.({
      agentId: "main",
      chunks: [{ text: "doc one" }],
      wait: true,
      concurrency: 1,
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
      debug: () => {},
    });

    const batchCalls = mocks.runOpenAiEmbeddingBatches.mock.calls as unknown as Array<
      [
        {
          requests: Array<{
            body: Record<string, unknown>;
          }>;
        },
      ]
    >;
    const [batchOptions] = batchCalls[0] ?? [];
    expect(batchOptions?.requests).toHaveLength(1);
    const request = batchOptions?.requests[0];
    expect(request?.body).toEqual({
      model: "text-embedding-3-small",
      input: "doc one",
      dimensions: 512,
      input_type: "document",
    });
  });
});
