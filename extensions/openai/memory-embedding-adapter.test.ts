// Openai tests cover memory embedding adapter plugin behavior.
import {
  resolveRemoteEmbeddingBearerClient,
  type MemoryEmbeddingProvider,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it("keeps native OpenAI embedding cache identity stable across OpenClaw versions", async () => {
    const createForVersion = async (version: string) => {
      vi.stubEnv("OPENCLAW_VERSION", version);
      const client = await resolveRemoteEmbeddingBearerClient({
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        options: {
          config: { models: {} } as never,
          model: "text-embedding-3-small",
          remote: { apiKey: "fixture-secret" },
        },
      });
      mocks.createOpenAiEmbeddingProvider.mockResolvedValueOnce({
        provider,
        client: { ...client, model: "text-embedding-3-small" },
      });
      const result = await openAiMemoryEmbeddingProviderAdapter.create({
        config: {} as never,
        provider: "openai",
        model: "text-embedding-3-small",
        fallback: "none",
      });
      return { headers: client.headers, cacheKeyData: result.runtime?.cacheKeyData };
    };

    const previous = await createForVersion("2026.7.1");
    const current = await createForVersion("2026.7.2");

    expect(previous.headers).toMatchObject({
      Authorization: "Bearer fixture-secret",
      version: "2026.7.1",
      "User-Agent": "openclaw/2026.7.1",
    });
    expect(current.headers).toMatchObject({
      Authorization: "Bearer fixture-secret",
      version: "2026.7.2",
      "User-Agent": "openclaw/2026.7.2",
    });
    expect(current.cacheKeyData).toEqual(previous.cacheKeyData);
    expect(hashText(JSON.stringify(current.cacheKeyData))).toBe(
      hashText(JSON.stringify(previous.cacheKeyData)),
    );
    expect(current.cacheKeyData).toMatchObject({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      headers: [
        ["Content-Type", "application/json"],
        ["originator", "openclaw"],
      ],
    });
    expect(JSON.stringify(current.cacheKeyData)).not.toContain("fixture-secret");
  });

  it("preserves custom endpoint tenant and version-like cache identity headers", async () => {
    const createForTenant = async (tenant: string) => {
      const client = await resolveRemoteEmbeddingBearerClient({
        provider: "bailian-embedding",
        defaultBaseUrl: "https://embeddings.example/v1",
        options: {
          config: { models: {} } as never,
          model: "text-embedding-v3",
          remote: {
            apiKey: "fixture-secret",
            headers: {
              "X-Tenant": tenant,
              version: "tenant-api-v2",
              "User-Agent": "tenant-client/2",
            },
          },
        },
      });
      mocks.createOpenAiEmbeddingProvider.mockResolvedValueOnce({
        provider,
        client: { ...client, model: "text-embedding-v3" },
      });
      return await openAiMemoryEmbeddingProviderAdapter.create({
        config: {} as never,
        provider: "bailian-embedding",
        model: "text-embedding-v3",
        fallback: "none",
      });
    };

    const first = await createForTenant("tenant-a");
    const second = await createForTenant("tenant-b");
    const headers = first.runtime?.cacheKeyData?.headers;

    expect(headers).toEqual(
      expect.arrayContaining([
        ["X-Tenant", "tenant-a"],
        ["version", "tenant-api-v2"],
        ["User-Agent", "tenant-client/2"],
      ]),
    );
    expect(first.runtime?.cacheKeyData).not.toEqual(second.runtime?.cacheKeyData);
    expect(JSON.stringify(first.runtime?.cacheKeyData)).not.toContain("fixture-secret");
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

  it("preserves the caller provider id for custom OpenAI-compatible embedding providers", async () => {
    const result = await openAiMemoryEmbeddingProviderAdapter.create({
      config: {} as never,
      provider: "bailian-embedding",
      model: "text-embedding-v3",
      fallback: "none",
    });

    expect(mocks.createOpenAiEmbeddingProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "bailian-embedding",
        fallback: "none",
        model: "text-embedding-v3",
      }),
    );
    expect(result.runtime?.cacheKeyData?.provider).toBe("bailian-embedding");
  });

  it("defaults provider id to openai when the caller leaves it unset", async () => {
    await openAiMemoryEmbeddingProviderAdapter.create({
      config: {} as never,
      model: "text-embedding-3-small",
      fallback: "none",
    });

    expect(mocks.createOpenAiEmbeddingProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
      }),
    );
  });
});
