import { describe, expect, it } from "vitest";
import { countTextTokens, countTokensFromChars, resolveTokenEncoding } from "./token-counter.ts";

describe("resolveTokenEncoding", () => {
  it("uses o200k_base for modern OpenAI models", () => {
    expect(resolveTokenEncoding({ provider: "openai", model: "gpt-5.6" })).toEqual({
      encoding: "o200k_base",
      approximate: false,
    });
  });

  it("uses cl100k_base for classic GPT-4 ids on non-OpenAI providers", () => {
    expect(resolveTokenEncoding({ provider: "azure", model: "gpt-4-0613" })).toEqual({
      encoding: "cl100k_base",
      approximate: false,
    });
  });

  it("marks custom / Qwen encodings approximate while still picking o200k", () => {
    expect(resolveTokenEncoding({ provider: "custom", model: "Qwen3.6-27B" })).toEqual({
      encoding: "o200k_base",
      approximate: true,
    });
  });

  it("honors explicit encoding overrides", () => {
    expect(
      resolveTokenEncoding({
        provider: "custom",
        model: "Qwen3.6-27B",
        encodingOverride: "cl100k_base",
      }),
    ).toEqual({ encoding: "cl100k_base", approximate: false });
  });
});

describe("countTextTokens", () => {
  it("returns a positive BPE count for plain ASCII", () => {
    const counted = countTextTokens("hello world", { encoding: "o200k_base" });
    expect(counted.approximate).toBe(false);
    expect(counted.tokens).toBeGreaterThan(0);
    expect(counted.tokens).toBeLessThan(10);
  });

  it("returns zero for empty text", () => {
    expect(countTextTokens("")).toEqual({ tokens: 0, approximate: false });
  });
});

describe("countTokensFromChars", () => {
  it("always marks char-only estimates approximate", () => {
    const counted = countTokensFromChars(400);
    expect(counted.approximate).toBe(true);
    expect(counted.tokens).toBeGreaterThan(0);
  });
});
