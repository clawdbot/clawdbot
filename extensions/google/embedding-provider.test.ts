// Google tests cover embedding provider plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")>();
  return {
    ...actual,
    withRemoteHttpResponse: (async <T>(params: {
      url: string;
      init?: RequestInit;
      onResponse: (response: Response) => Promise<T>;
    }): Promise<T> => {
      const response = await fetch(params.url, params.init);
      return await params.onResponse(response);
    }) satisfies typeof actual.withRemoteHttpResponse,
  };
});

import { createGeminiEmbeddingProvider } from "./embedding-provider.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function installFetchMock(
  handler: (input: RequestInfo | URL, init?: RequestInit) => unknown,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    return new Response(JSON.stringify(handler(input, init)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fetchJsonBody(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected JSON string request body.");
  }
  return JSON.parse(body) as unknown;
}

function requireFirstFetchInput(fetchMock: ReturnType<typeof vi.fn>): RequestInfo | URL {
  const [call] = fetchMock.mock.calls;
  if (!call) {
    throw new Error("expected Gemini embedding fetch call");
  }
  return call[0] as RequestInfo | URL;
}

function axisVector(length: number, index = 0, value = 1): number[] {
  return Array.from({ length }, (_, offset) => (offset === index ? value : 0));
}

describe("Gemini embedding provider", () => {
  const providerBaseUrl = "https://provider.example.test/v1beta";
  const config = {
    models: {
      providers: {
        google: {
          baseUrl: providerBaseUrl,
          apiKey: "provider-key",
          headers: { "X-Provider-Tenant": "provider-a" },
          models: [],
        },
      },
    },
  };

  it.each([
    {
      name: "provider-owned",
      remote: { baseUrl: providerBaseUrl },
      expectedApiKey: "provider-key",
      expectedHeaders: { "X-Provider-Tenant": "provider-a" },
    },
    {
      name: "remote-owned with a resolved env-looking literal",
      remote: {
        baseUrl: "https://remote.example.test/v1beta",
        apiKey: "GOOGLE_API_KEY",
        headers: { "X-Remote-Tenant": "remote-b" },
      },
      expectedApiKey: "GOOGLE_API_KEY",
      expectedHeaders: { "X-Remote-Tenant": "remote-b" },
    },
    {
      name: "query-distinct on the provider host",
      remote: {
        baseUrl: `${providerBaseUrl}?tenant=remote`,
        apiKey: "remote-tenant-key",
        headers: { "X-Remote-Tenant": "remote-b" },
      },
      expectedApiKey: "remote-tenant-key",
      expectedHeaders: { "X-Remote-Tenant": "remote-b" },
    },
  ])("binds Gemini credentials to the $name destination", async (testCase) => {
    vi.stubEnv("GOOGLE_API_KEY", testCase.remote.baseUrl === providerBaseUrl ? "" : "ambient-bait");
    const { client, provider } = await createGeminiEmbeddingProvider({
      config: config as never,
      provider: "google",
      remote: testCase.remote,
      model: "gemini-embedding-001",
      fallback: "none",
    });

    expect(client.apiKeys).toContain(testCase.expectedApiKey);
    expect(client.headers).toMatchObject(testCase.expectedHeaders);
    if (testCase.remote.baseUrl !== providerBaseUrl) {
      expect(client.apiKeys).toEqual([testCase.expectedApiKey]);
      expect(client.headers).not.toHaveProperty("X-Provider-Tenant");
    }
    if (testCase.remote.baseUrl.includes("?")) {
      const fetchMock = installFetchMock(() => ({ embedding: { values: [1, 0] } }));
      await expect(provider.embedQuery("hello")).resolves.toEqual([1, 0]);
      const fetchInput = requireFirstFetchInput(fetchMock);
      const requestUrl = new URL(
        typeof fetchInput === "string"
          ? fetchInput
          : fetchInput instanceof URL
            ? fetchInput.href
            : fetchInput.url,
      );
      expect(requestUrl.pathname).toBe("/v1beta/models/gemini-embedding-001:embedContent");
      expect(requestUrl.search).toBe("?tenant=remote");
    }
  });

  it("rejects an unauthenticated remote destination before provider-key fallback", async () => {
    await expect(
      createGeminiEmbeddingProvider({
        config: config as never,
        provider: "google",
        remote: { baseUrl: "https://remote.example.test/v1beta" },
        model: "gemini-embedding-001",
        fallback: "none",
      }),
    ).rejects.toThrow(/memory\.search\.remote\.apiKey/);
  });

  it.each(["models/", "gemini/", "google/"])(
    "normalizes the %s model prefix through the provider request",
    async (prefix) => {
      const fetchMock = installFetchMock(() => ({
        embedding: { values: axisVector(768) },
      }));
      const { provider } = await createGeminiEmbeddingProvider({
        config: {} as never,
        provider: "gemini",
        remote: { apiKey: "placeholder" },
        model: `${prefix}gemini-embedding-2`,
        outputDimensionality: 768,
        fallback: "none",
      });

      await provider.embedQuery("query");

      expect(requireFirstFetchInput(fetchMock)).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
      );
    },
  );

  it.each(
    ["gemini-embedding-001", "gemini-embedding-2", "gemini-embedding-2-preview"].flatMap((model) =>
      [128, 512, 1024, 3072].map((dimensions) => [model, dimensions] as const),
    ),
  )("supports %s with %i output dimensions", async (model, dimensions) => {
    const fetchMock = installFetchMock((input) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      return url.endsWith(":batchEmbedContents")
        ? { embeddings: [{ values: axisVector(dimensions) }] }
        : { embedding: { values: axisVector(dimensions) } };
    });
    const { provider, client } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      remote: { apiKey: "placeholder" },
      model,
      outputDimensionality: dimensions,
      fallback: "none",
    });

    expect(client.outputDimensionality).toBe(dimensions);
    await expect(provider.embedQuery("query")).resolves.toHaveLength(dimensions);
    await expect(provider.embedBatch(["document"])).resolves.toEqual([axisVector(dimensions)]);
    expect(fetchJsonBody(fetchMock, 0)).toMatchObject({ outputDimensionality: dimensions });
    expect(fetchJsonBody(fetchMock, 1)).toMatchObject({
      requests: [{ outputDimensionality: dimensions }],
    });
  });

  it.each(
    ["gemini-embedding-001", "gemini-embedding-2", "gemini-embedding-2-preview"].flatMap((model) =>
      [127, 512.5, 3073].map((dimensions) => [model, dimensions] as const),
    ),
  )("rejects unsupported %s dimension %i before making a request", async (model, dimensions) => {
    await expect(
      createGeminiEmbeddingProvider({
        config: {} as never,
        provider: "gemini",
        remote: { apiKey: "placeholder" },
        model,
        outputDimensionality: dimensions,
        fallback: "none",
      }),
    ).rejects.toThrow(/integer between 128 and 3072/);
  });

  it.each([
    ["gemini-embedding-001", undefined],
    ["gemini-embedding-2", 3072],
    ["gemini-embedding-2-preview", 3072],
  ] as const)(
    "preserves the existing default dimension identity for %s",
    async (model, dimensions) => {
      const { client } = await createGeminiEmbeddingProvider({
        config: {} as never,
        provider: "gemini",
        remote: { apiKey: "placeholder" },
        model,
        fallback: "none",
      });

      expect(client.outputDimensionality).toBe(dimensions);
    },
  );

  it("handles legacy and v2 request/response behavior", async () => {
    const fetchMock = installFetchMock((input) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      return url.endsWith(":batchEmbedContents")
        ? {
            embeddings: Array.from({ length: 2 }, () => ({
              values: axisVector(768, 2, 5),
            })),
          }
        : {
            embedding: {
              values: Array.from({ length: 768 }, (_, index) =>
                index === 0 ? 3 : index === 1 ? 4 : 0,
              ),
            },
          };
    });

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      remote: { apiKey: "test-key" },
      model: "gemini-embedding-2",
      outputDimensionality: 768,
      taskType: "SEMANTIC_SIMILARITY",
      fallback: "none",
    });

    await expect(provider.embedQuery("   ")).resolves.toStrictEqual([]);
    await expect(provider.embedBatch([])).resolves.toStrictEqual([]);
    const queryEmbedding = await provider.embedQuery("test query");
    expect(queryEmbedding).toHaveLength(768);
    expect(queryEmbedding.slice(0, 3)).toEqual([0.6, 0.8, 0]);

    const structuredBatch = await provider.embedBatchInputs?.([
      {
        text: "Image file: diagram.png",
        parts: [
          { type: "text", text: "Image file: diagram.png" },
          { type: "inline-data", mimeType: "image/png", data: "img" },
        ],
      },
      {
        text: "Audio file: note.wav",
        parts: [
          { type: "text", text: "Audio file: note.wav" },
          { type: "inline-data", mimeType: "audio/wav", data: "aud" },
        ],
      },
    ]);
    expect(structuredBatch).toHaveLength(2);
    expect(structuredBatch?.[0]).toHaveLength(768);
    expect(structuredBatch?.[0]?.slice(0, 4)).toEqual([0, 0, 1, 0]);
    expect(structuredBatch?.[1]).toEqual(structuredBatch?.[0]);

    expect(requireFirstFetchInput(fetchMock)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
    );
    expect(fetchJsonBody(fetchMock, 0)).toEqual({
      outputDimensionality: 768,
      content: { parts: [{ text: "task: sentence similarity | query: test query" }] },
    });
    expect(fetchJsonBody(fetchMock, 1)).toEqual({
      requests: [
        {
          model: "models/gemini-embedding-2",
          content: {
            parts: [
              { text: "Image file: diagram.png" },
              { inlineData: { mimeType: "image/png", data: "img" } },
            ],
          },
          outputDimensionality: 768,
        },
        {
          model: "models/gemini-embedding-2",
          content: {
            parts: [
              { text: "Audio file: note.wav" },
              { inlineData: { mimeType: "audio/wav", data: "aud" } },
            ],
          },
          outputDimensionality: 768,
        },
      ],
    });
  });

  it("rejects non-object successful embedding responses", async () => {
    installFetchMock(() => []);

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      remote: { apiKey: "test-key" },
      model: "gemini-embedding-001",
      fallback: "none",
    });

    await expect(provider.embedQuery("test query")).rejects.toThrow(
      "gemini embeddings failed: malformed JSON response",
    );
  });

  it("rejects wrong single embedding vector shapes", async () => {
    installFetchMock(() => ({ embedding: { values: [1, "bad"] } }));

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      remote: { apiKey: "test-key" },
      model: "gemini-embedding-001",
      fallback: "none",
    });

    await expect(provider.embedQuery("test query")).rejects.toThrow(
      "gemini embeddings failed: malformed JSON response",
    );
  });

  it("rejects batch embedding count mismatches", async () => {
    installFetchMock(() => ({ embeddings: [{ values: [1, 2] }] }));

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      remote: { apiKey: "test-key" },
      model: "gemini-embedding-001",
      fallback: "none",
    });

    await expect(provider.embedBatch(["one", "two"])).rejects.toThrow(
      "gemini embeddings failed: malformed JSON response",
    );
  });

  it("keeps the preview identifier compatible during migration", async () => {
    const fetchMock = installFetchMock(() => ({
      embedding: { values: axisVector(768) },
    }));
    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      remote: { apiKey: "test-key" },
      model: "gemini-embedding-2-preview",
      outputDimensionality: 768,
      fallback: "none",
    });

    await expect(provider.embedQuery("test query")).resolves.toHaveLength(768);
    expect(requireFirstFetchInput(fetchMock)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent",
    );
    expect(fetchJsonBody(fetchMock, 0)).toEqual({
      content: { parts: [{ text: "test query" }] },
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: 768,
    });
  });

  it("formats stable Gemini retrieval requests without unsupported task types", async () => {
    const fetchMock = installFetchMock((input) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      return url.endsWith(":batchEmbedContents")
        ? { embeddings: [{ values: axisVector(768) }] }
        : { embedding: { values: axisVector(768) } };
    });
    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      remote: { apiKey: "test-key" },
      model: "gemini-embedding-2",
      outputDimensionality: 768,
      fallback: "none",
    });

    await provider.embedQuery("find this");
    await provider.embedBatch(["remember this"]);

    expect(fetchJsonBody(fetchMock, 0)).toEqual({
      content: { parts: [{ text: "task: search result | query: find this" }] },
      outputDimensionality: 768,
    });
    expect(fetchJsonBody(fetchMock, 1)).toEqual({
      requests: [
        {
          content: { parts: [{ text: "title: none | text: remember this" }] },
          model: "models/gemini-embedding-2",
          outputDimensionality: 768,
        },
      ],
    });
  });

  it.each([
    ["QUESTION_ANSWERING", "question answering"],
    ["FACT_VERIFICATION", "fact checking"],
  ] as const)("keeps %s query and document instructions asymmetric", async (taskType, task) => {
    const fetchMock = installFetchMock((input) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      return url.endsWith(":batchEmbedContents")
        ? { embeddings: [{ values: axisVector(768) }] }
        : { embedding: { values: axisVector(768) } };
    });
    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      remote: { apiKey: "test-key" },
      model: "gemini-embedding-2",
      outputDimensionality: 768,
      taskType,
      fallback: "none",
    });

    await provider.embedQuery("find this");
    await provider.embedBatch(["remember this"]);

    expect(fetchJsonBody(fetchMock, 0)).toMatchObject({
      content: { parts: [{ text: `task: ${task} | query: find this` }] },
    });
    expect(fetchJsonBody(fetchMock, 1)).toMatchObject({
      requests: [{ content: { parts: [{ text: "title: none | text: remember this" }] } }],
    });
  });

  it("rejects Gemini 2 responses that drift from the requested dimensions", async () => {
    installFetchMock((input) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      return url.endsWith(":batchEmbedContents")
        ? { embeddings: [{ values: axisVector(3072) }] }
        : { embedding: { values: axisVector(3072) } };
    });
    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      remote: { apiKey: "test-key" },
      model: "gemini-embedding-2",
      outputDimensionality: 768,
      fallback: "none",
    });

    await expect(provider.embedQuery("test query")).rejects.toThrow(
      "gemini embeddings failed: expected 768 dimensions, received 3072",
    );
    await expect(provider.embedBatch(["test document"])).rejects.toThrow(
      "gemini embeddings failed: expected 768 dimensions, received 3072",
    );
  });
});
