// Memory Host SDK tests cover embeddings model normalize behavior.
import { describe, expect, it } from "vitest";
import { normalizeEmbeddingModelWithPrefixes } from "./embeddings-model-normalize.js";

describe("normalizeEmbeddingModelWithPrefixes", () => {
  it("returns default model when input is blank", () => {
    expect(
      normalizeEmbeddingModelWithPrefixes({
        model: "   ",
        defaultModel: "fallback-model",
        prefixes: ["openai/"],
      }),
    ).toBe("fallback-model");
  });

  it("strips the first matching prefix", () => {
    expect(
      normalizeEmbeddingModelWithPrefixes({
        model: "openai/text-embedding-3-small",
        defaultModel: "fallback-model",
        prefixes: ["openai/"],
      }),
    ).toBe("text-embedding-3-small");
  });

  it("keeps explicit model names when no prefix matches", () => {
    expect(
      normalizeEmbeddingModelWithPrefixes({
        model: "voyage-4-large",
        defaultModel: "fallback-model",
        prefixes: ["voyage/"],
      }),
    ).toBe("voyage-4-large");
  });
});
