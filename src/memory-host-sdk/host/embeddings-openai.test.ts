import { describe, expect, it } from "vitest";
import { DEFAULT_OPENAI_EMBEDDING_MODEL, normalizeOpenAiModel } from "./embeddings-openai.js";

describe("normalizeOpenAiModel", () => {
  it("returns the default model when input is blank", () => {
    expect(normalizeOpenAiModel("")).toBe(DEFAULT_OPENAI_EMBEDDING_MODEL);
    expect(normalizeOpenAiModel("   ")).toBe(DEFAULT_OPENAI_EMBEDDING_MODEL);
  });

  it("strips the openai/ prefix", () => {
    expect(normalizeOpenAiModel("openai/text-embedding-3-small")).toBe("text-embedding-3-small");
    expect(normalizeOpenAiModel("openai/text-embedding-ada-002")).toBe("text-embedding-ada-002");
  });

  it("preserves explicit third-party provider prefixes", () => {
    expect(normalizeOpenAiModel("spark/text-embedding-3-small")).toBe(
      "spark/text-embedding-3-small",
    );
    expect(normalizeOpenAiModel("litellm/azure/ada-002")).toBe("litellm/azure/ada-002");
  });

  it("preserves unprefixed model ids", () => {
    expect(normalizeOpenAiModel("text-embedding-3-large")).toBe("text-embedding-3-large");
  });
});
