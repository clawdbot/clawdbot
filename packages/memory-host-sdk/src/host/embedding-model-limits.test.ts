import { describe, expect, it } from "vitest";
import {
  resolveEmbeddingMaxInputsPerRequest,
  resolveEmbeddingMaxInputTokens,
} from "./embedding-model-limits.js";
import type { EmbeddingProvider } from "./embeddings.types.js";

function provider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    id: "fixture",
    model: "fixture-model",
    embed: async () => [],
    embedBatch: async () => [],
    ...overrides,
  };
}

describe("embedding model limits", () => {
  it("resolves the declared per-request input cap", () => {
    expect(resolveEmbeddingMaxInputsPerRequest(provider({ maxInputsPerRequest: 2048 }))).toBe(2048);
  });

  it("falls back to a conservative input cap when the provider declares none", () => {
    expect(resolveEmbeddingMaxInputsPerRequest(provider())).toBe(64);
  });

  it("ignores non-positive declared input caps", () => {
    expect(resolveEmbeddingMaxInputsPerRequest(provider({ maxInputsPerRequest: 0 }))).toBe(64);
    expect(resolveEmbeddingMaxInputsPerRequest(provider({ maxInputsPerRequest: -4 }))).toBe(64);
  });

  it("still resolves token limits from the provider declaration", () => {
    expect(resolveEmbeddingMaxInputTokens(provider({ maxInputTokens: 3072 }))).toBe(3072);
    expect(resolveEmbeddingMaxInputTokens(provider({ id: "local" }))).toBe(2048);
    expect(resolveEmbeddingMaxInputTokens(provider())).toBe(8192);
  });
});
