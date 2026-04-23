import { describe, expect, it } from "vitest";
import { deriveSessionTotalTokens, hasNonzeroUsage, normalizeUsage } from "./usage.js";

describe("normalizeUsage", () => {
  it("normalizes Anthropic-style snake_case usage", () => {
    const usage = normalizeUsage({
      input_tokens: 1200,
      output_tokens: 340,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 50,
      total_tokens: 1790,
    });
    expect(usage).toEqual({
      input: 1200,
      output: 340,
      cacheRead: 50,
      cacheWrite: 200,
      total: 1790,
    });
  });

  it("normalizes OpenAI-style prompt/completion usage", () => {
    const usage = normalizeUsage({
      prompt_tokens: 987,
      completion_tokens: 123,
      total_tokens: 1110,
    });
    expect(usage).toEqual({
      input: 987,
      output: 123,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: 1110,
    });
  });

  it("normalizes llama.cpp completion timings", () => {
    const usage = normalizeUsage({
      timings: {
        prompt_n: 30_834,
        predicted_n: 34,
      },
    });
    expect(usage).toEqual({
      input: 30_834,
      output: 34,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: undefined,
    });
  });

  it("clamps negative and fractional usage counts to safe integers", () => {
    const usage = normalizeUsage({
      input: -12.8,
      output: 9.9,
      cacheRead: -1,
      cacheWrite: 3.2,
      total: -99,
    });
    expect(usage).toEqual({
      input: 0,
      output: 9,
      cacheRead: 0,
      cacheWrite: 3,
      total: 0,
    });
  });

  it("caps extremely large usage counts at Number.MAX_SAFE_INTEGER", () => {
    const usage = normalizeUsage({
      input: 1e308,
      output: Number.MAX_SAFE_INTEGER + 1000,
    });
    expect(usage).toEqual({
      input: Number.MAX_SAFE_INTEGER,
      output: Number.MAX_SAFE_INTEGER,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: undefined,
    });
  });

  it("returns undefined for empty usage objects", () => {
    expect(normalizeUsage({})).toBeUndefined();
  });

  it("guards against empty/zero usage overwrites", () => {
    expect(hasNonzeroUsage(undefined)).toBe(false);
    expect(hasNonzeroUsage(null)).toBe(false);
    expect(hasNonzeroUsage({})).toBe(false);
    expect(hasNonzeroUsage({ input: 0, output: 0 })).toBe(false);
    expect(hasNonzeroUsage({ input: 1 })).toBe(true);
    expect(hasNonzeroUsage({ total: 1 })).toBe(true);
  });

  it("does not clamp derived session total tokens to the context window", () => {
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 27,
          cacheRead: 2_400_000,
          cacheWrite: 0,
          total: 2_402_300,
        },
        contextTokens: 200_000,
      }),
    ).toBe(2_400_027);
  });

  it("uses prompt tokens when within context window", () => {
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 1_200,
          cacheRead: 300,
          cacheWrite: 50,
          total: 2_000,
        },
        contextTokens: 200_000,
      }),
    ).toBe(1_550);
  });

  it("prefers explicit prompt token overrides", () => {
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 1_200,
          cacheRead: 300,
          cacheWrite: 50,
          total: 9_999,
        },
        promptTokens: 65_000,
        contextTokens: 200_000,
      }),
    ).toBe(65_000);
  });
});
