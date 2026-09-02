import type { MemoryEmbeddingProviderCreateOptions } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { describe, expect, it } from "vitest";
import { createMistralEmbeddingProvider } from "./embedding-provider.js";
import { mistralMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import { MISTRAL_BASE_URL } from "./model-definitions.js";

function createOptions(params?: {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  config?: MemoryEmbeddingProviderCreateOptions["config"];
}): MemoryEmbeddingProviderCreateOptions {
  return {
    config: params?.config ?? ({} as MemoryEmbeddingProviderCreateOptions["config"]),
    provider: "mistral",
    model: "mistral-embed",
    fallback: "none",
    remote: {
      apiKey: params?.apiKey ?? "fixture-mistral-key-before",
      ...(params?.baseUrl ? { baseUrl: params.baseUrl } : {}),
      ...(params?.headers ? { headers: params.headers } : {}),
    },
  };
}

describe("Mistral memory embedding index identity", () => {
  it.each([undefined, MISTRAL_BASE_URL, `${MISTRAL_BASE_URL}/`, "https://API.MISTRAL.AI:443/v1/"])(
    "preserves the exact existing default identity for %s",
    async (baseUrl) => {
      const result = await mistralMemoryEmbeddingProviderAdapter.create(createOptions({ baseUrl }));

      expect(result.runtime?.cacheKeyData).toEqual({
        provider: "mistral",
        model: "mistral-embed",
      });
    },
  );

  it("partitions endpoints and tenants without including rotated authentication headers", async () => {
    const endpoint = "https://mistral-region-a.example.test/v1";
    const firstOptions = createOptions({
      baseUrl: endpoint,
      headers: {
        "X-Tenant": "tenant-a",
        "X-Deployment": "deployment-a",
        "X-Api-Key": "fixture-proxy-key-before",
        "api-key": "fixture-azure-key-before",
        "User-Agent": "tenant-router/1",
        version: "tenant-api-v1",
      },
    });
    const first = await mistralMemoryEmbeddingProviderAdapter.create(firstOptions);
    const rotated = await mistralMemoryEmbeddingProviderAdapter.create(
      createOptions({
        baseUrl: endpoint,
        apiKey: "fixture-mistral-key-after",
        headers: {
          version: "tenant-api-v1",
          "User-Agent": "tenant-router/1",
          "Api-Key": "fixture-azure-key-after",
          "x-aPI-kEY": "fixture-proxy-key-after",
          "X-Deployment": "deployment-a",
          "X-Tenant": "tenant-a",
        },
      }),
    );
    const otherTenant = await mistralMemoryEmbeddingProviderAdapter.create(
      createOptions({
        baseUrl: endpoint,
        headers: { "X-Tenant": "tenant-b", "X-Deployment": "deployment-a" },
      }),
    );
    const otherEndpoint = await mistralMemoryEmbeddingProviderAdapter.create(
      createOptions({
        baseUrl: "https://mistral-region-b.example.test/v1",
        headers: { "X-Tenant": "tenant-a", "X-Deployment": "deployment-a" },
      }),
    );
    const { client } = await createMistralEmbeddingProvider(firstOptions);

    expect(client.headers).toMatchObject({
      Authorization: "Bearer fixture-mistral-key-before",
      "X-Api-Key": "fixture-proxy-key-before",
      "api-key": "fixture-azure-key-before",
      "X-Deployment": "deployment-a",
      "X-Tenant": "tenant-a",
    });
    expect(first.runtime?.cacheKeyData).toMatchObject({
      provider: "mistral",
      model: "mistral-embed",
      baseUrl: endpoint,
      headers: expect.arrayContaining([
        ["X-Deployment", "deployment-a"],
        ["X-Tenant", "tenant-a"],
        ["User-Agent", "tenant-router/1"],
        ["version", "tenant-api-v1"],
      ]),
    });
    expect(first.runtime?.cacheKeyData).toEqual(rotated.runtime?.cacheKeyData);
    expect(first.runtime?.cacheKeyData).not.toEqual(otherTenant.runtime?.cacheKeyData);
    expect(first.runtime?.cacheKeyData).not.toEqual(otherEndpoint.runtime?.cacheKeyData);
    expect(JSON.stringify(first.runtime?.cacheKeyData)).not.toContain("fixture-");
  });

  it("partitions provider-owned headers without leaking them to a remote destination", async () => {
    const providerBaseUrl = "https://provider-region.example.test/v1";
    const config = {
      models: {
        providers: {
          mistral: {
            baseUrl: providerBaseUrl,
            apiKey: "fixture-provider-key",
            headers: { "X-Provider-Tenant": "provider-a" },
            models: [],
          },
        },
      },
    } as MemoryEmbeddingProviderCreateOptions["config"];
    const providerOwned = await mistralMemoryEmbeddingProviderAdapter.create(
      createOptions({ config }),
    );
    const remoteOptions = createOptions({
      config,
      baseUrl: "https://remote-region.example.test/v1",
      headers: { "X-Tenant": "remote-a" },
    });
    const remoteOwned = await mistralMemoryEmbeddingProviderAdapter.create(remoteOptions);
    const { client } = await createMistralEmbeddingProvider(remoteOptions);

    expect(providerOwned.runtime?.cacheKeyData).toMatchObject({
      baseUrl: providerBaseUrl,
      headers: [["X-Provider-Tenant", "provider-a"]],
    });
    expect(remoteOwned.runtime?.cacheKeyData).toMatchObject({
      baseUrl: "https://remote-region.example.test/v1",
      headers: [["X-Tenant", "remote-a"]],
    });
    expect(client.headers).not.toHaveProperty("X-Provider-Tenant");
    expect(client.headers["X-Tenant"]).toBe("remote-a");
  });
});
