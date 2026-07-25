// Deepinfra tests cover its generic embedding adapter behavior.
import type { MemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDeepInfraEmbeddingProvider: vi.fn(),
}));

vi.mock("./embedding-provider.js", () => ({
  createDeepInfraEmbeddingProvider: mocks.createDeepInfraEmbeddingProvider,
  DEFAULT_DEEPINFRA_EMBEDDING_MODEL: "BAAI/bge-m3",
}));

import { deepinfraEmbeddingProviderAdapter } from "./embedding-adapter.js";
import { DEEPINFRA_BASE_URL } from "./media-models.js";

const memoryProvider: MemoryEmbeddingProvider = {
  id: "deepinfra",
  model: "BAAI/bge-m3",
  maxInputTokens: 8192,
  embedQuery: vi.fn(async () => [1, 0]),
  embedBatch: vi.fn(async (texts) => texts.map(() => [0, 1])),
  close: vi.fn(),
};

describe("DeepInfra generic embedding adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // resolveRemoteEmbeddingClient always resolves a base URL and headers, so the
    // stub carries them too — the adapter now reads both to scope cache identity.
    mocks.createDeepInfraEmbeddingProvider.mockResolvedValue({
      provider: memoryProvider,
      client: {
        model: "BAAI/bge-m3-resolved",
        baseUrl: DEEPINFRA_BASE_URL,
        headers: { Authorization: "Bearer redacted" }, // pragma: allowlist secret
      },
    });
  });

  it("declares the existing provider id, default model, transport, and auth owner", () => {
    expect(deepinfraEmbeddingProviderAdapter).toMatchObject({
      id: "deepinfra",
      defaultModel: "BAAI/bge-m3",
      transport: "remote",
      authProviderId: "deepinfra",
      create: expect.any(Function),
    });
  });

  it("preserves model, dimensions, input types, and runtime identity when creating", async () => {
    const result = await deepinfraEmbeddingProviderAdapter.create({
      config: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "deepinfra",
      remote: {
        baseUrl: "https://api.deepinfra.com/v1/openai",
        apiKey: "fixture-key",
        headers: { "x-deployment": "tenant-a" },
      },
      model: "BAAI/bge-m3",
      inputType: "semantic",
      queryInputType: "query",
      documentInputType: "document",
      dimensions: 1024,
      taskType: "SEMANTIC_SIMILARITY",
    });

    expect(mocks.createDeepInfraEmbeddingProvider).toHaveBeenCalledWith({
      config: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "deepinfra",
      fallback: "none",
      remote: {
        baseUrl: "https://api.deepinfra.com/v1/openai",
        apiKey: "fixture-key",
        headers: { "x-deployment": "tenant-a" },
      },
      model: "BAAI/bge-m3",
      inputType: "semantic",
      queryInputType: "query",
      documentInputType: "document",
      outputDimensionality: 1024,
      taskType: "SEMANTIC_SIMILARITY",
      defaultModel: "BAAI/bge-m3",
    });
    expect(result.runtime).toEqual({
      id: "deepinfra",
      cacheKeyData: { provider: "deepinfra", model: "BAAI/bge-m3-resolved" },
    });
    expect(result.provider).toMatchObject({
      id: "deepinfra",
      model: "BAAI/bge-m3",
      maxInputTokens: 8192,
    });
  });

  it("adapts generic query and batch calls without changing text or cancellation", async () => {
    const result = await deepinfraEmbeddingProviderAdapter.create({
      config: {},
      model: "BAAI/bge-m3",
    });
    const provider = result.provider;
    if (!provider) {
      throw new Error("expected DeepInfra embedding provider");
    }
    const abortController = new AbortController();

    await expect(
      provider.embed(
        { text: "query text" },
        { signal: abortController.signal, inputType: "query" },
      ),
    ).resolves.toEqual([1, 0]);
    await expect(
      provider.embedBatch(["document one", { text: "document two" }], {
        signal: abortController.signal,
        inputType: "document",
      }),
    ).resolves.toEqual([
      [0, 1],
      [0, 1],
    ]);
    await provider.close?.();

    expect(memoryProvider.embedQuery).toHaveBeenCalledWith("query text", {
      signal: abortController.signal,
    });
    expect(memoryProvider.embedBatch).toHaveBeenCalledWith(["document one", "document two"], {
      signal: abortController.signal,
    });
    expect(memoryProvider.close).toHaveBeenCalledOnce();
  });

  describe("cache identity", () => {
    async function cacheKeyData(client: {
      baseUrl: string;
      headers: Record<string, string>;
      model: string;
    }): Promise<Record<string, unknown>> {
      mocks.createDeepInfraEmbeddingProvider.mockResolvedValue({
        provider: memoryProvider,
        client,
      });
      const result = await deepinfraEmbeddingProviderAdapter.create({} as never);
      if (!result.runtime) {
        throw new Error("expected the adapter to expose an embedding runtime");
      }
      return result.runtime.cacheKeyData as Record<string, unknown>;
    }

    it("keeps the shipped default identity for the default endpoint", async () => {
      expect(
        await cacheKeyData({
          baseUrl: DEEPINFRA_BASE_URL,
          headers: { Authorization: "Bearer redacted" }, // pragma: allowlist secret
          model: "BAAI/bge-m3",
        }),
      ).toEqual({ provider: "deepinfra", model: "BAAI/bge-m3" });
    });

    it("scopes cache identity by base URL when a custom endpoint is configured", async () => {
      expect(
        await cacheKeyData({
          baseUrl: "https://deepinfra.proxy.internal/v1/openai",
          headers: { Authorization: "Bearer redacted" }, // pragma: allowlist secret
          model: "BAAI/bge-m3",
        }),
      ).toEqual({
        provider: "deepinfra",
        baseUrl: "https://deepinfra.proxy.internal/v1/openai",
        model: "BAAI/bge-m3",
      });
    });

    it("hashes custom header identity without leaking raw values", async () => {
      const data = await cacheKeyData({
        baseUrl: DEEPINFRA_BASE_URL,
        headers: {
          Authorization: "Bearer redacted", // pragma: allowlist secret
          "X-Tenant": "tenant-a",
        },
        model: "BAAI/bge-m3",
      });
      expect(data.headersHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(data)).not.toContain("tenant-a");
    });
  });
});
