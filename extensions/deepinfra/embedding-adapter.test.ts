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

import {
  buildDeepInfraEmbeddingAdapter,
  deepinfraEmbeddingProviderAdapter,
} from "./embedding-adapter.js";

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
    mocks.createDeepInfraEmbeddingProvider.mockImplementation(
      async (options: {
        remote?: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> };
      }) => ({
        provider: memoryProvider,
        client: {
          model: "BAAI/bge-m3-resolved",
          baseUrl: options.remote?.baseUrl ?? "https://api.deepinfra.com/v1/openai",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.remote?.apiKey ?? "fixture-default-key"}`,
            ...options.remote?.headers,
          },
        },
      }),
    );
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

  it("keeps the discovered embedding model as the dynamic adapter default", async () => {
    const adapter = buildDeepInfraEmbeddingAdapter({
      embedModels: [{ id: "BAAI/discovered-model" }] as never,
    });

    expect(adapter.defaultModel).toBe("BAAI/discovered-model");
    await adapter.create({ config: {}, model: "BAAI/discovered-model" });
    expect(mocks.createDeepInfraEmbeddingProvider).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: "BAAI/discovered-model" }),
    );
  });

  it.each([
    undefined,
    "https://api.deepinfra.com/v1/openai",
    "https://api.deepinfra.com/v1/openai/",
    "https://API.DEEPINFRA.COM:443/v1/openai/",
  ])("preserves the exact existing default identity for %s", async (baseUrl) => {
    const result = await deepinfraEmbeddingProviderAdapter.create({
      config: {},
      model: "BAAI/bge-m3",
      remote: { apiKey: "fixture-default-key", ...(baseUrl ? { baseUrl } : {}) },
    });

    expect(result.runtime?.cacheKeyData).toEqual({
      provider: "deepinfra",
      model: "BAAI/bge-m3-resolved",
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
      cacheKeyData: {
        provider: "deepinfra",
        model: "BAAI/bge-m3-resolved",
        baseUrl: "https://api.deepinfra.com/v1/openai",
        headers: [["x-deployment", "tenant-a"]],
      },
    });
    expect(result.provider).toMatchObject({
      id: "deepinfra",
      model: "BAAI/bge-m3",
      maxInputTokens: 8192,
    });
  });

  it("partitions endpoints and tenants while excluding rotated credentials", async () => {
    const baseUrl = "https://deepinfra-region-a.example.test/v1/openai";
    const createForTenant = async (
      tenant: string,
      endpoint = baseUrl,
      apiKey = "fixture-deepinfra-key-before",
      headers: Record<string, string> = {},
    ) =>
      await deepinfraEmbeddingProviderAdapter.create({
        config: {},
        model: "BAAI/bge-m3",
        remote: {
          baseUrl: endpoint,
          apiKey,
          headers: { "x-deployment": "deployment-a", "X-Tenant": tenant, ...headers },
        },
      });

    const first = await createForTenant("tenant-a", baseUrl, "fixture-deepinfra-key-before", {
      "X-Api-Key": "fixture-proxy-key-before",
      "api-key": "fixture-azure-key-before",
      version: "tenant-api-v1",
    });
    const rotated = await createForTenant("tenant-a", baseUrl, "fixture-deepinfra-key-after", {
      version: "tenant-api-v1",
      "Api-Key": "fixture-azure-key-after",
      "x-aPI-kEY": "fixture-proxy-key-after",
    });
    const otherTenant = await createForTenant("tenant-b");
    const otherEndpoint = await createForTenant(
      "tenant-a",
      "https://deepinfra-region-b.example.test/v1/openai",
    );
    const firstProvider = await mocks.createDeepInfraEmbeddingProvider.mock.results[0]?.value;

    expect(firstProvider?.client.headers).toMatchObject({
      Authorization: "Bearer fixture-deepinfra-key-before",
      "X-Api-Key": "fixture-proxy-key-before",
      "api-key": "fixture-azure-key-before",
      "x-deployment": "deployment-a",
      "X-Tenant": "tenant-a",
    });
    expect(first.runtime?.cacheKeyData).toMatchObject({
      provider: "deepinfra",
      model: "BAAI/bge-m3-resolved",
      baseUrl,
      headers: expect.arrayContaining([
        ["x-deployment", "deployment-a"],
        ["X-Tenant", "tenant-a"],
        ["version", "tenant-api-v1"],
      ]),
    });
    expect(first.runtime?.cacheKeyData).toEqual(rotated.runtime?.cacheKeyData);
    expect(first.runtime?.cacheKeyData).not.toEqual(otherTenant.runtime?.cacheKeyData);
    expect(first.runtime?.cacheKeyData).not.toEqual(otherEndpoint.runtime?.cacheKeyData);
    expect(JSON.stringify(first.runtime?.cacheKeyData)).not.toContain("fixture-");
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
    await expect(provider.embed("query without an explicit type")).resolves.toEqual([1, 0]);
    await expect(
      provider.embedBatch(["document one", { text: "document two" }], {
        signal: abortController.signal,
        inputType: "document",
      }),
    ).resolves.toEqual([
      [0, 1],
      [0, 1],
    ]);
    await expect(
      provider.embedBatch(["query one", "query two"], { inputType: "query" }),
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
});
