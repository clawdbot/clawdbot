import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGeminiEmbeddingRequest,
  buildGeminiTextEmbeddingRequest,
  createGeminiEmbeddingProvider,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  GEMINI_EMBEDDING_2_MODELS,
  isGeminiEmbedding2Model,
  normalizeGeminiModel,
  resolveGeminiOutputDimensionality,
} from "./embedding-provider.js";

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

describe("Gemini embedding request helpers", () => {
  it("builds requests and resolves model settings", () => {
    expect(
      buildGeminiTextEmbeddingRequest({
        text: "hello",
        taskType: "RETRIEVAL_DOCUMENT",
        modelPath: "models/gemini-embedding-2-preview",
        outputDimensionality: 1536,
      }),
    ).toEqual({
      model: "models/gemini-embedding-2-preview",
      content: { parts: [{ text: "hello" }] },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: 1536,
    });
    expect(
      buildGeminiEmbeddingRequest({
        input: {
          text: "Image file: diagram.png",
          parts: [
            { type: "text", text: "Image file: diagram.png" },
            { type: "inline-data", mimeType: "image/png", data: "abc123" },
          ],
        },
        taskType: "RETRIEVAL_DOCUMENT",
        modelPath: "models/gemini-embedding-2-preview",
        outputDimensionality: 1536,
      }),
    ).toEqual({
      model: "models/gemini-embedding-2-preview",
      content: {
        parts: [
          { text: "Image file: diagram.png" },
          { inlineData: { mimeType: "image/png", data: "abc123" } },
        ],
      },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: 1536,
    });
    expect(GEMINI_EMBEDDING_2_MODELS.has("gemini-embedding-2-preview")).toBe(true);
    expect(isGeminiEmbedding2Model("gemini-embedding-2-preview")).toBe(true);
    expect(isGeminiEmbedding2Model("gemini-embedding-001")).toBe(false);
    expect(isGeminiEmbedding2Model("text-embedding-004")).toBe(false);
    expect(resolveGeminiOutputDimensionality("gemini-embedding-001")).toBeUndefined();
    expect(resolveGeminiOutputDimensionality("text-embedding-004")).toBeUndefined();
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview")).toBe(3072);
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 768)).toBe(768);
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 1536)).toBe(1536);
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 3072)).toBe(3072);
    expect(() => resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 512)).toThrow(
      /Invalid outputDimensionality 512/,
    );
    expect(() => resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 1024)).toThrow(
      /Valid values: 768, 1536, 3072/,
    );
    expect(normalizeGeminiModel("models/gemini-embedding-2-preview")).toBe(
      "gemini-embedding-2-preview",
    );
    expect(normalizeGeminiModel("gemini/gemini-embedding-2-preview")).toBe(
      "gemini-embedding-2-preview",
    );
    expect(normalizeGeminiModel("google/gemini-embedding-2-preview")).toBe(
      "gemini-embedding-2-preview",
    );
    expect(normalizeGeminiModel("")).toBe(DEFAULT_GEMINI_EMBEDDING_MODEL);
  });
});

describe("Gemini embedding provider", () => {
  it("handles legacy and v2 request/response behavior", async () => {
    const fetchMock = installFetchMock((input) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      return url.endsWith(":batchEmbedContents")
        ? {
            embeddings: Array.from({ length: 2 }, () => ({
              values: [0, Number.POSITIVE_INFINITY, 5],
            })),
          }
        : { embedding: { values: [3, 4, Number.NaN] } };
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
});
