import { describe, expect, it } from "vitest";
import { enforceEmbeddingMaxInputTokens } from "./embedding-chunk-limits.js";
import { estimateUtf8Bytes } from "./embedding-input-limits.js";
import type { EmbeddingProvider } from "./embeddings.js";

function createProvider(maxInputTokens: number): EmbeddingProvider {
  return {
    id: "mock",
    model: "mock-embed",
    maxInputTokens,
    embedQuery: async () => [0],
    embedBatch: async () => [[0]],
  };
}

function createProviderWithoutMaxInputTokens(params: {
  id: string;
  model: string;
}): EmbeddingProvider {
  return {
    id: params.id,
    model: params.model,
    embedQuery: async () => [0],
    embedBatch: async () => [[0]],
  };
}

type EmbeddingChunks = ReturnType<typeof enforceEmbeddingMaxInputTokens>;

function expectChunksWithinUtf8Bytes(chunks: EmbeddingChunks, maxBytes: number) {
  const oversized: Array<{ index: number; bytes: number }> = [];
  for (const [index, chunk] of chunks.entries()) {
    const bytes = estimateUtf8Bytes(chunk.text);
    if (bytes > maxBytes) {
      oversized.push({ index, bytes });
    }
  }
  expect(oversized).toStrictEqual([]);
}

function expectChunksLineRange(chunks: EmbeddingChunks, startLine: number, endLine: number) {
  const unexpectedRanges: Array<{ index: number; startLine: number; endLine: number }> = [];
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.startLine !== startLine || chunk.endLine !== endLine) {
      unexpectedRanges.push({ index, startLine: chunk.startLine, endLine: chunk.endLine });
    }
  }
  expect(unexpectedRanges).toStrictEqual([]);
}

function expectChunksHaveHashes(chunks: EmbeddingChunks) {
  const invalidHashes: Array<{ index: number; hash: unknown }> = [];
  for (const [index, chunk] of chunks.entries()) {
    if (typeof chunk.hash !== "string" || chunk.hash.length === 0) {
      invalidHashes.push({ index, hash: chunk.hash });
    }
  }
  expect(invalidHashes).toStrictEqual([]);
}

function joinedChunkText(chunks: EmbeddingChunks): string {
  let text = "";
  for (const chunk of chunks) {
    text += chunk.text;
  }
  return text;
}

describe("embedding chunk limits", () => {
  it("splits oversized chunks so each embedding input stays <= maxInputTokens bytes", () => {
    const provider = createProvider(8192);
    const input = {
      startLine: 1,
      endLine: 1,
      text: "x".repeat(9000),
      hash: "ignored",
    };

    const out = enforceEmbeddingMaxInputTokens(provider, [input]);
    expect(out.length).toBeGreaterThan(1);
    expect(joinedChunkText(out)).toBe(input.text);
    expectChunksWithinUtf8Bytes(out, 8192);
    expectChunksLineRange(out, 1, 1);
    expectChunksHaveHashes(out);
  });

  it("does not split inside surrogate pairs (emoji)", () => {
    const provider = createProvider(8192);
    const emoji = "😀";
    const inputText = `${emoji.repeat(2100)}\n${emoji.repeat(2100)}`;

    const out = enforceEmbeddingMaxInputTokens(provider, [
      { startLine: 1, endLine: 2, text: inputText, hash: "ignored" },
    ]);

    expect(out.length).toBeGreaterThan(1);
    expect(joinedChunkText(out)).toBe(inputText);
    expectChunksWithinUtf8Bytes(out, 8192);

    // If we split inside surrogate pairs we'd likely end up with replacement chars.
    expect(joinedChunkText(out)).not.toContain("\uFFFD");
  });

  it("uses conservative fallback limits for local providers without declared maxInputTokens", () => {
    const provider = createProviderWithoutMaxInputTokens({
      id: "local",
      model: "unknown-local-embedding",
    });

    const out = enforceEmbeddingMaxInputTokens(provider, [
      {
        startLine: 1,
        endLine: 1,
        text: "x".repeat(3000),
        hash: "ignored",
      },
    ]);

    expect(out.length).toBeGreaterThan(1);
    expectChunksWithinUtf8Bytes(out, 2048);
  });

  it("honors hard safety caps lower than provider maxInputTokens", () => {
    const provider = createProvider(8192);
    const out = enforceEmbeddingMaxInputTokens(
      provider,
      [
        {
          startLine: 1,
          endLine: 1,
          text: "x".repeat(8100),
          hash: "ignored",
        },
      ],
      8000,
    );

    expect(out.length).toBeGreaterThan(1);
    expectChunksWithinUtf8Bytes(out, 8000);
  });
});
