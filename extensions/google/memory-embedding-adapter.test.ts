// Google tests cover memory embedding adapter plugin behavior.
import {
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProvider,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGeminiEmbeddingProvider: vi.fn(),
  runGeminiEmbeddingBatches: vi.fn(async () => new Map([["0", [1, 0]]])),
}));

vi.mock("./embedding-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedding-provider.js")>();
  return {
    ...actual,
    createGeminiEmbeddingProvider: mocks.createGeminiEmbeddingProvider,
  };
});

vi.mock("./embedding-batch.js", () => ({
  runGeminiEmbeddingBatches: mocks.runGeminiEmbeddingBatches,
}));

import { geminiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

const provider: MemoryEmbeddingProvider = {
  id: "gemini",
  model: "gemini-embedding-2",
  embedQuery: async () => [1, 0],
  embedBatch: async (texts) => texts.map(() => [1, 0]),
};

const clientBase = {
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  model: "gemini-embedding-2",
  modelPath: "models/gemini-embedding-2",
  outputDimensionality: 768,
};

async function createAdapterWithHeaders(headers: Record<string, string>) {
  mocks.createGeminiEmbeddingProvider.mockResolvedValueOnce({
    provider,
    client: { ...clientBase, headers },
  });
  return await geminiMemoryEmbeddingProviderAdapter.create({
    config: {} as never,
    provider: "gemini",
    model: "gemini-embedding-2",
    fallback: "none",
  });
}

describe("Gemini memory embedding adapter", () => {
  beforeEach(() => {
    mocks.createGeminiEmbeddingProvider.mockReset();
    mocks.runGeminiEmbeddingBatches.mockClear();
  });

  it.each([
    "gemini-embedding-2",
    "gemini-embedding-2-preview",
    "models/gemini-embedding-2",
    "gemini/gemini-embedding-2",
    "google/gemini-embedding-2",
  ])("accepts multimodal memory for %s", (model) => {
    expect(geminiMemoryEmbeddingProviderAdapter.supportsMultimodalEmbeddings?.({ model })).toBe(
      true,
    );
  });

  it("keeps legacy Gemini embeddings text-only", () => {
    expect(
      geminiMemoryEmbeddingProviderAdapter.supportsMultimodalEmbeddings?.({
        model: "gemini-embedding-001",
      }),
    ).toBe(false);
  });

  it("formats stable Gemini asynchronous batch documents without a task type", async () => {
    const result = await createAdapterWithHeaders({});

    await result.runtime?.batchEmbed?.({
      agentId: "main",
      chunks: [{ text: "remember this" }],
      wait: true,
      concurrency: 1,
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
      debug: () => {},
    });

    expect(mocks.runGeminiEmbeddingBatches).toHaveBeenCalledWith(
      expect.objectContaining({
        requests: [
          {
            custom_id: "0",
            request: {
              content: { parts: [{ text: "title: none | text: remember this" }] },
              model: "models/gemini-embedding-2",
              outputDimensionality: 768,
            },
          },
        ],
      }),
    );
  });

  it("keeps durable identity stable across generated client-version changes", async () => {
    const sharedHeaders = {
      "Content-Type": "application/json",
      "x-goog-api-key": "secret-key",
      Authorization: "Bearer token",
      "X-Custom-Region": "us-central1",
    };
    const older = await createAdapterWithHeaders({
      ...sharedHeaders,
      "x-goog-api-client": "openclaw/2026.6.11",
    });
    const newer = await createAdapterWithHeaders({
      ...sharedHeaders,
      "x-goog-api-client": "openclaw/2026.7.1-beta.5",
    });

    expect(older.runtime?.cacheKeyData).toEqual(newer.runtime?.cacheKeyData);
    expect(older.runtime?.cacheKeyData?.headers).toEqual(
      sanitizeEmbeddingCacheHeaders(
        {
          "Content-Type": "application/json",
          "X-Custom-Region": "us-central1",
        },
        [],
      ),
    );
  });

  it("still invalidates identity when a semantic custom header changes", async () => {
    const first = await createAdapterWithHeaders({
      "x-goog-api-client": "openclaw/2026.7.1-beta.5",
      "x-custom-endpoint": "https://example.invalid/a",
    });
    const second = await createAdapterWithHeaders({
      "x-goog-api-client": "openclaw/2026.7.1-beta.5",
      "x-custom-endpoint": "https://example.invalid/b",
    });

    expect(first.runtime?.cacheKeyData).not.toEqual(second.runtime?.cacheKeyData);
  });
});
