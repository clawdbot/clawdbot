// Openai tests cover embedding provider plugin behavior.
import type { MemoryEmbeddingProviderCreateOptions } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DEFAULT_MOCK_CLIENT = {
  baseUrl: "https://embeddings.example/v1",
  headers: { Authorization: "Bearer test" },
  model: "text-embedding-3-small",
};

const mocks = vi.hoisted(() => ({
  fetchRemoteEmbeddingVectors: vi.fn(async () => [[1, 0]]),
  resolveRemoteEmbeddingClient: vi.fn(async () => ({ ...DEFAULT_MOCK_CLIENT })),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", () => ({
  fetchRemoteEmbeddingVectors: mocks.fetchRemoteEmbeddingVectors,
  resolveRemoteEmbeddingClient: mocks.resolveRemoteEmbeddingClient,
}));

import { createOpenAiEmbeddingProvider } from "./embedding-provider.js";

function createOptions(
  overrides: Partial<MemoryEmbeddingProviderCreateOptions> = {},
): MemoryEmbeddingProviderCreateOptions {
  return {
    config: {} as MemoryEmbeddingProviderCreateOptions["config"],
    provider: "openai",
    model: "text-embedding-3-small",
    fallback: "none",
    ...overrides,
  };
}

function expectFetchRemoteEmbeddingVectorsBody(body: Record<string, unknown>) {
  expect(mocks.fetchRemoteEmbeddingVectors).toHaveBeenCalledWith({
    url: "https://embeddings.example/v1/embeddings",
    headers: { Authorization: "Bearer test" },
    ssrfPolicy: undefined,
    fetchImpl: undefined,
    signal: undefined,
    body,
    errorPrefix: "openai embeddings failed",
  });
}

describe("OpenAI embedding provider", () => {
  beforeEach(() => {
    mocks.fetchRemoteEmbeddingVectors.mockClear();
    mocks.resolveRemoteEmbeddingClient.mockClear();
  });

  it("sends queryInputType on query embeddings", async () => {
    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({ inputType: "passage", queryInputType: "query" }),
    );

    await provider.embedQuery("hello");

    expectFetchRemoteEmbeddingVectorsBody({
      model: "text-embedding-3-small",
      input: ["hello"],
      input_type: "query",
    });
  });

  it("sends documentInputType on document batch embeddings", async () => {
    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({ inputType: "query", documentInputType: "document" }),
    );

    await provider.embedBatch(["doc one", "doc two"]);

    expectFetchRemoteEmbeddingVectorsBody({
      model: "text-embedding-3-small",
      input: ["doc one", "doc two"],
      input_type: "document",
    });
  });

  it("omits input_type unless configured", async () => {
    const { provider } = await createOpenAiEmbeddingProvider(createOptions());

    await provider.embedBatch(["doc"]);

    expectFetchRemoteEmbeddingVectorsBody({
      model: "text-embedding-3-small",
      input: ["doc"],
    });
  });

  it("sends outputDimensionality as OpenAI dimensions", async () => {
    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({ outputDimensionality: 512 }),
    );

    await provider.embedBatch(["doc"]);

    expectFetchRemoteEmbeddingVectorsBody({
      model: "text-embedding-3-small",
      input: ["doc"],
      dimensions: 512,
    });
  });

  it("forwards custom provider ids to the remote embedding client", async () => {
    await createOpenAiEmbeddingProvider(createOptions({ provider: "bailian-embedding" }));

    expect(mocks.resolveRemoteEmbeddingClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "bailian-embedding",
      }),
    );
  });

  it("defaults the remote embedding client lookup to openai", async () => {
    await createOpenAiEmbeddingProvider(createOptions({ provider: undefined }));

    expect(mocks.resolveRemoteEmbeddingClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
      }),
    );
  });

  // --- openai/ prefix preservation ---

  it("strips openai/ prefix when using native OpenAI API base URL", async () => {
    mocks.resolveRemoteEmbeddingClient.mockResolvedValueOnce({
      ...DEFAULT_MOCK_CLIENT,
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
    });

    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({ model: "openai/text-embedding-3-small" }),
    );

    expect(provider.model).toBe("text-embedding-3-small");
  });

  it("strips openai/ prefix for semantically native URLs (uppercase hostname)", async () => {
    mocks.resolveRemoteEmbeddingClient.mockResolvedValueOnce({
      ...DEFAULT_MOCK_CLIENT,
      baseUrl: "https://API.OPENAI.COM/v1",
      model: "text-embedding-3-small",
    });

    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({ model: "openai/text-embedding-3-small" }),
    );

    expect(provider.model).toBe("text-embedding-3-small");
  });

  it("preserves openai/ prefix for non-native OpenAI base URLs", async () => {
    mocks.resolveRemoteEmbeddingClient.mockResolvedValueOnce({
      ...DEFAULT_MOCK_CLIENT,
      baseUrl: "https://router.requesty.ai/v1",
      model: "text-embedding-3-small",
    });

    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({ model: "openai/text-embedding-3-small" }),
    );

    expect(provider.model).toBe("openai/text-embedding-3-small");
  });

  it("provides maxInputTokens for qualified model with non-native base URL", async () => {
    mocks.resolveRemoteEmbeddingClient.mockResolvedValueOnce({
      ...DEFAULT_MOCK_CLIENT,
      baseUrl: "https://router.requesty.ai/v1",
      model: "text-embedding-3-small",
    });

    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({ model: "openai/text-embedding-3-small" }),
    );

    expect(provider.maxInputTokens).toBe(8192);
  });

  it("preserves openai/ prefix in embedding request body for non-native base URLs", async () => {
    mocks.resolveRemoteEmbeddingClient.mockResolvedValueOnce({
      ...DEFAULT_MOCK_CLIENT,
      baseUrl: "https://router.requesty.ai/v1",
      model: "text-embedding-3-small",
    });

    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({
        model: "openai/text-embedding-3-small",
        inputType: "query",
      }),
    );

    await provider.embedQuery("test");

    expect(mocks.fetchRemoteEmbeddingVectors).toHaveBeenCalledWith({
      url: "https://router.requesty.ai/v1/embeddings",
      headers: { Authorization: "Bearer test" },
      ssrfPolicy: undefined,
      fetchImpl: undefined,
      signal: undefined,
      body: {
        model: "openai/text-embedding-3-small",
        input: ["test"],
        input_type: "query",
      },
      errorPrefix: "openai embeddings failed",
    });
  });
});
