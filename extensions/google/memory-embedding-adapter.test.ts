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

vi.mock("./embedding-provider.js", () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: "gemini-embedding-001",
  createGeminiEmbeddingProvider: mocks.createGeminiEmbeddingProvider,
  buildGeminiEmbeddingRequest: vi.fn(),
}));

vi.mock("./embedding-batch.js", () => ({
  runGeminiEmbeddingBatches: mocks.runGeminiEmbeddingBatches,
}));

import { geminiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

const provider: MemoryEmbeddingProvider = {
  id: "gemini",
  model: "gemini-embedding-2-preview",
  embedQuery: async () => [1, 0],
  embedBatch: async (texts) => texts.map(() => [1, 0]),
};

const clientBase = {
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  model: "gemini-embedding-2-preview",
  modelPath: "models/gemini-embedding-2-preview",
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
    model: "gemini-embedding-2-preview",
    fallback: "none",
  });
}

describe("Gemini memory embedding adapter", () => {
  beforeEach(() => {
    mocks.createGeminiEmbeddingProvider.mockReset();
    mocks.runGeminiEmbeddingBatches.mockClear();
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
