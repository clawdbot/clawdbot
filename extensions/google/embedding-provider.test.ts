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

describe("Gemini embedding provider", () => {
  it.each(["models/", "gemini/", "google/"])(
    "normalizes the %s model prefix through the provider request",
    async (prefix) => {
      const fetchMock = installFetchMock(() => ({ embedding: { values: [1, 0] } }));
      const { provider } = await createGeminiEmbeddingProvider({
        config: {} as never,
        provider: "gemini",
        remote: { apiKey: "placeholder" },
        model: `${prefix}gemini-embedding-2-preview`,
        fallback: "none",
      });

      await provider.embedQuery("query");

      expect(requireFirstFetchInput(fetchMock)).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent",
      );
    },
  );

  it("rejects unsupported Gemini 2 output dimensions through provider creation", async () => {
    await expect(
      createGeminiEmbeddingProvider({
        config: {} as never,
        provider: "gemini",
        remote: { apiKey: "placeholder" },
        model: "gemini-embedding-2-preview",
        outputDimensionality: 1024,
        fallback: "none",
      }),
    ).rejects.toThrow(/Valid values: 768, 1536, 3072/);
  });

  it("handles legacy and v2 request/response behavior", async () => {
    const fetchMock = installFetchMock((input) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      return url.endsWith(":batchEmbedContents")
        ? {
            embeddings: Array.from({ length: 2 }, () => ({
              values: [0, 0, 5],
            })),
          }
        : { embedding: { values: [3, 4, 0] } };
    });

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      remote: { apiKey: "test-key" },
      model: "gemini-embedding-2-preview",
      outputDimensionality: 768,
      taskType: "SEMANTIC_SIMILARITY",
      fallback: "none",
    });

    await expect(provider.embedQuery("   ")).resolves.toStrictEqual([]);
    await expect(provider.embedBatch([])).resolves.toStrictEqual([]);
    await expect(provider.embedQuery("test query")).resolves.toEqual([0.6, 0.8, 0]);

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
    expect(structuredBatch).toEqual([
      [0, 0, 1],
      [0, 0, 1],
    ]);

    expect(requireFirstFetchInput(fetchMock)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent",
    );
    expect(fetchJsonBody(fetchMock, 0)).toEqual({
      outputDimensionality: 768,
      taskType: "SEMANTIC_SIMILARITY",
      content: { parts: [{ text: "test query" }] },
    });
    expect(fetchJsonBody(fetchMock, 1)).toEqual({
      requests: [
        {
          model: "models/gemini-embedding-2-preview",
          content: {
            parts: [
              { text: "Image file: diagram.png" },
              { inlineData: { mimeType: "image/png", data: "img" } },
            ],
          },
          taskType: "SEMANTIC_SIMILARITY",
          outputDimensionality: 768,
        },
        {
          model: "models/gemini-embedding-2-preview",
          content: {
            parts: [
              { text: "Audio file: note.wav" },
              { inlineData: { mimeType: "audio/wav", data: "aud" } },
            ],
          },
          taskType: "SEMANTIC_SIMILARITY",
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
});
