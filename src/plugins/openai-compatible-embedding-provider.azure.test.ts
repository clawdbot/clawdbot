// Covers Azure OpenAI-compatible embedding request target normalization at the
// openai-compatible adapter request boundary.
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProviderCreateOptions } from "./embedding-providers.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

const withRemoteHttpResponseMock = vi.hoisted(() => vi.fn());

vi.mock("../../packages/memory-host-sdk/src/host/remote-http.js", () => ({
  withRemoteHttpResponse: withRemoteHttpResponseMock,
}));

function createOptions(
  overrides: Partial<EmbeddingProviderCreateOptions> = {},
): EmbeddingProviderCreateOptions {
  return {
    config: {} as EmbeddingProviderCreateOptions["config"],
    provider: "openai-compatible",
    model: "text-embedding-bge-m3",
    ...overrides,
  };
}

function respondWithEmbedding(onResponse: (response: Response) => Promise<unknown>) {
  return onResponse(
    new Response(
      JSON.stringify({
        object: "list",
        data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ),
  );
}

describe("openai-compatible Azure OpenAI embedding requests", () => {
  it("moves a configured api-version header into the URL query for Azure hosts", async () => {
    const azureBaseUrl =
      "https://example.openai.azure.com/openai/deployments/text-embedding-3-small";
    withRemoteHttpResponseMock.mockReset();
    withRemoteHttpResponseMock.mockImplementationOnce(
      async ({
        url,
        init,
        onResponse,
      }: {
        url: string;
        init: RequestInit;
        onResponse: Function;
      }) => {
        expect(url).toBe(`${azureBaseUrl}/embeddings?api-version=2024-10-21`);
        expect(init.headers).not.toHaveProperty("api-version");
        return await respondWithEmbedding(onResponse as (r: Response) => Promise<unknown>);
      },
    );

    const result = await openAICompatibleEmbeddingProviderAdapter.create(
      createOptions({
        remote: {
          baseUrl: azureBaseUrl,
          headers: {
            "api-key": "azure-key",
            "api-version": "2024-10-21",
          },
        },
      }),
    );
    const provider = result.provider;
    if (!provider) {
      throw new Error("expected openai-compatible provider");
    }
    await expect(provider.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);

    expect(withRemoteHttpResponseMock).toHaveBeenCalledOnce();
  });

  it("keeps non-Azure embedding requests unchanged", async () => {
    const proxyBaseUrl = "https://proxy.example.com/v1";
    withRemoteHttpResponseMock.mockReset();
    withRemoteHttpResponseMock.mockImplementationOnce(
      async ({
        url,
        init,
        onResponse,
      }: {
        url: string;
        init: RequestInit;
        onResponse: Function;
      }) => {
        expect(url).toBe(`${proxyBaseUrl}/embeddings`);
        expect(init.headers).toHaveProperty("api-version", "proxy-header");
        return await respondWithEmbedding(onResponse as (r: Response) => Promise<unknown>);
      },
    );

    const result = await openAICompatibleEmbeddingProviderAdapter.create(
      createOptions({
        remote: {
          baseUrl: proxyBaseUrl,
          headers: {
            "api-version": "proxy-header",
          },
        },
      }),
    );
    const provider = result.provider;
    if (!provider) {
      throw new Error("expected openai-compatible provider");
    }
    await expect(provider.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);

    expect(withRemoteHttpResponseMock).toHaveBeenCalledOnce();
  });
});
