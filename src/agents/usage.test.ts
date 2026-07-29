/**
 * Regression coverage for token usage normalization.
 * Verifies provider usage aliases, OpenAI-compatible output, and prompt-token derivation.
 */
import { describe, expect, it } from "vitest";
import {
  deriveContextPromptTokens,
  derivePromptTokens,
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  normalizeUsage,
  toOpenAiChatCompletionsUsage,
} from "./usage.js";

describe("normalizeUsage", () => {
  it("preserves only complete context snapshots", () => {
    expect(
      normalizeUsage({
        input: 12,
        contextUsage: { state: "available", promptTokens: 148_874, totalTokens: 163_978 },
      }),
    ).toMatchObject({
      input: 12,
      contextUsage: { state: "available", promptTokens: 148_874, totalTokens: 163_978 },
    });
    expect(
      normalizeUsage({
        input: 12,
        contextUsage: { state: "available", promptTokens: 163_978, totalTokens: 148_874 },
      }),
    ).toEqual({
      input: 12,
      output: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: undefined,
    });
  });

  it("normalizes cache fields from provider response", () => {
    const usage = normalizeUsage({
      input: 1000,
      output: 500,
      cacheRead: 2000,
      cacheWrite: 300,
    });
    expect(usage).toEqual({
      input: 1000,
      output: 500,
      cacheRead: 2000,
      cacheWrite: 300,
      total: undefined,
    });
  });

  it("normalizes cache fields from alternate naming", () => {
    const usage = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 300,
    });
    expect(usage).toEqual({
      input: 1000,
      output: 500,
      cacheRead: 2000,
      cacheWrite: 300,
      total: undefined,
    });
  });

  it("handles cache_read and cache_write naming variants", () => {
    const usage = normalizeUsage({
      input: 1000,
      cache_read: 1500,
      cache_write: 200,
    });
    expect(usage).toEqual({
      input: 1000,
      output: undefined,
      cacheRead: 1500,
      cacheWrite: 200,
      total: undefined,
    });
  });

  it("handles Moonshot/Kimi cached_tokens field", () => {
    // Moonshot v1 returns cached_tokens instead of cache_read_input_tokens
    const usage = normalizeUsage({
      prompt_tokens: 30,
      completion_tokens: 9,
      total_tokens: 39,
      cached_tokens: 19,
    });
    expect(usage).toEqual({
      input: 11,
      output: 9,
      cacheRead: 19,
      cacheWrite: undefined,
      total: 39,
    });
  });

  it("handles Kimi K2 prompt_tokens_details.cached_tokens field", () => {
    // Kimi K2 uses automatic prefix caching and returns cached_tokens in prompt_tokens_details
    const usage = normalizeUsage({
      prompt_tokens: 1113,
      completion_tokens: 5,
      total_tokens: 1118,
      prompt_tokens_details: { cached_tokens: 1024 },
    });
    expect(usage).toEqual({
      input: 89,
      output: 5,
      cacheRead: 1024,
      cacheWrite: undefined,
      total: 1118,
    });
  });

  it("handles OpenAI Responses input_tokens_details.cached_tokens field", () => {
    const usage = normalizeUsage({
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 250,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 17 },
    });
    expect(usage).toEqual({
      input: 20,
      output: 30,
      cacheRead: 100,
      cacheWrite: undefined,
      reasoningTokens: 17,
      total: 250,
    });
  });

  it("handles OpenAI Chat Completions reasoning token details", () => {
    const usage = normalizeUsage({
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      completion_tokens_details: { reasoning_tokens: 11 },
    });
    expect(usage).toEqual({
      input: 120,
      output: 30,
      cacheRead: undefined,
      cacheWrite: undefined,
      reasoningTokens: 11,
      total: 150,
    });
  });

  it("clamps negative input to zero (pre-subtracted cached_tokens > prompt_tokens)", () => {
    // shared model runtime OpenAI-format providers subtract cached_tokens from prompt_tokens
    // upstream.  When cached_tokens exceeds prompt_tokens the result is negative.
    const usage = normalizeUsage({
      input: -4900,
      output: 200,
      cacheRead: 5000,
    });
    expect(usage).toEqual({
      input: 0,
      output: 200,
      cacheRead: 5000,
      cacheWrite: undefined,
      total: undefined,
    });
  });

  it("clamps negative prompt_tokens alias to zero", () => {
    const usage = normalizeUsage({
      prompt_tokens: -12,
      completion_tokens: 4,
    });
    expect(usage).toEqual({
      input: 0,
      output: 4,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: undefined,
    });
  });

  it("returns undefined when no valid fields are provided", () => {
    const usage = normalizeUsage(null);
    expect(usage).toBeUndefined();
  });

  it("handles undefined input", () => {
    const usage = normalizeUsage(undefined);
    expect(usage).toBeUndefined();
  });
});

describe("toOpenAiChatCompletionsUsage", () => {
  it("uses max(component sum, aggregate total) when breakdown is partial", () => {
    const usage = normalizeUsage({ output_tokens: 20, total_tokens: 100 });
    expect(toOpenAiChatCompletionsUsage(usage)).toEqual({
      prompt_tokens: 0,
      completion_tokens: 20,
      total_tokens: 100,
    });
  });

  it("uses component sum when it exceeds aggregate total", () => {
    expect(
      toOpenAiChatCompletionsUsage({
        input: 30,
        output: 40,
        total: 50,
      }),
    ).toEqual({
      prompt_tokens: 30,
      completion_tokens: 40,
      total_tokens: 70,
    });
  });

  it("uses aggregate total when only total is present", () => {
    const usage = normalizeUsage({ total_tokens: 42 });
    expect(toOpenAiChatCompletionsUsage(usage)).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 42,
    });
  });

  it("preserves reasoning token details", () => {
    const usage = normalizeUsage({
      prompt_tokens: 10,
      completion_tokens: 8,
      completion_tokens_details: { reasoning_tokens: 6 },
      total_tokens: 18,
    });
    expect(toOpenAiChatCompletionsUsage(usage)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 8,
      completion_tokens_details: { reasoning_tokens: 6 },
      total_tokens: 18,
    });
  });

  it("returns zeros for undefined usage", () => {
    expect(toOpenAiChatCompletionsUsage(undefined)).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it("raises total_tokens with aggregate when cache write is excluded from prompt sum", () => {
    expect(
      toOpenAiChatCompletionsUsage({
        input: 10,
        output: 5,
        cacheWrite: 100,
        total: 200,
      }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 200,
    });
  });

  it("clamps negative completion before deriving total_tokens", () => {
    expect(
      toOpenAiChatCompletionsUsage({
        input: 3,
        output: -5,
      }),
    ).toEqual({
      prompt_tokens: 3,
      completion_tokens: 0,
      total_tokens: 3,
    });
  });

  it("preserves aggregate total when components are partially negative", () => {
    expect(
      toOpenAiChatCompletionsUsage({
        input: 3,
        output: -5,
        total: 7,
      }),
    ).toEqual({
      prompt_tokens: 3,
      completion_tokens: 0,
      total_tokens: 7,
    });
  });

  it("forwards cached_tokens via prompt_tokens_details when cache was hit", () => {
    expect(
      toOpenAiChatCompletionsUsage({
        input: 594,
        output: 79,
        cacheRead: 30848,
        cacheWrite: 0,
        total: 31521,
      }),
    ).toEqual({
      prompt_tokens: 31442,
      completion_tokens: 79,
      total_tokens: 31521,
      prompt_tokens_details: { cached_tokens: 30848 },
    });
  });

  it("omits prompt_tokens_details when no cache was read", () => {
    const result = toOpenAiChatCompletionsUsage({
      input: 1000,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1050,
    });
    expect(result).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
    });
    expect("prompt_tokens_details" in result).toBe(false);
  });
});

describe("hasNonzeroUsage", () => {
  it("returns true when cache read is nonzero", () => {
    const usage = { cacheRead: 100 };
    expect(hasNonzeroUsage(usage)).toBe(true);
  });

  it("returns true when cache write is nonzero", () => {
    const usage = { cacheWrite: 50 };
    expect(hasNonzeroUsage(usage)).toBe(true);
  });

  it("returns true when both cache fields are nonzero", () => {
    const usage = { cacheRead: 100, cacheWrite: 50 };
    expect(hasNonzeroUsage(usage)).toBe(true);
  });

  it("returns false when cache fields are zero", () => {
    const usage = { cacheRead: 0, cacheWrite: 0 };
    expect(hasNonzeroUsage(usage)).toBe(false);
  });

  it("returns false for undefined usage", () => {
    expect(hasNonzeroUsage(undefined)).toBe(false);
  });
});

describe("derivePromptTokens", () => {
  it("includes cache tokens in prompt total", () => {
    const usage = {
      input: 1000,
      cacheRead: 500,
      cacheWrite: 200,
    };
    const promptTokens = derivePromptTokens(usage);
    expect(promptTokens).toBe(1700); // 1000 + 500 + 200
  });

  it("handles missing cache fields", () => {
    const usage = {
      input: 1000,
    };
    const promptTokens = derivePromptTokens(usage);
    expect(promptTokens).toBe(1000);
  });

  it("returns undefined for empty usage", () => {
    const promptTokens = derivePromptTokens({});
    expect(promptTokens).toBeUndefined();
  });
});

describe("deriveContextPromptTokens", () => {
  it("prefers explicit prompt snapshot over provider usage", () => {
    expect(
      deriveContextPromptTokens({
        promptTokens: 44_000,
        lastCallUsage: { input: 55_000, cacheRead: 25_000 },
        usage: { input: 75_000, cacheRead: 25_000, output: 5_000, total: 105_000 },
      }),
    ).toBe(44_000);
  });

  it("falls back to last-call prompt usage before accumulated usage", () => {
    expect(
      deriveContextPromptTokens({
        lastCallUsage: { input: 55_000, cacheRead: 25_000, cacheWrite: 1_000 },
        usage: { input: 75_000, cacheRead: 25_000, output: 5_000, total: 105_000 },
      }),
    ).toBe(81_000);
  });

  it("prefers explicit prompt buckets over total-minus-output fallback", () => {
    expect(
      deriveContextPromptTokens({
        lastCallUsage: { input: 20, cacheRead: 100, output: 30, total: 250 },
      }),
    ).toBe(120);
  });

  it("prefers an explicit final-iteration context snapshot over aggregate billing usage", () => {
    expect(
      deriveContextPromptTokens({
        lastCallUsage: {
          input: 12,
          output: 15_104,
          cacheRead: 819_661,
          cacheWrite: 93_130,
          contextUsage: {
            state: "available",
            promptTokens: 148_874,
            totalTokens: 163_978,
          },
          total: 927_907,
        },
      }),
    ).toBe(148_874);
  });

  it("does not reconstruct context when the provider snapshot is unavailable", () => {
    expect(
      deriveContextPromptTokens({
        lastCallUsage: {
          input: 12,
          output: 15_104,
          cacheRead: 819_661,
          cacheWrite: 93_130,
          contextUsage: { state: "unavailable" },
          total: 927_907,
        },
      }),
    ).toBeUndefined();
  });

  it("does not treat total-only usage as a prompt snapshot", () => {
    expect(
      deriveContextPromptTokens({
        lastCallUsage: { input: 1_000, total: 1_200 },
      }),
    ).toBe(1_000);
    expect(
      deriveContextPromptTokens({
        lastCallUsage: { total: 1_200 },
      }),
    ).toBeUndefined();
    expect(
      deriveContextPromptTokens({
        lastCallUsage: { output: 200, total: 1_200 },
      }),
    ).toBe(1_000);
  });

  it("falls back to accumulated usage when no prompt snapshot exists", () => {
    expect(
      deriveContextPromptTokens({
        usage: { input: 75_000, cacheRead: 25_000, output: 5_000, total: 105_000 },
      }),
    ).toBe(100_000);
  });

  it("keeps accumulated usage on its component-based context snapshot", () => {
    expect(
      deriveContextPromptTokens({
        usage: { input: 10_000, cacheRead: 26_000, output: 1_000, total: 36_000 },
      }),
    ).toBe(36_000);
  });
});

describe("deriveSessionTotalTokens", () => {
  it("prefers last-call usage over aggregate billing usage", () => {
    expect(
      deriveSessionTotalTokens({
        lastCallUsage: { input: 38_333, output: 66, cacheRead: 120_320, total: 158_719 },
        usage: {
          input: 497_720,
          output: 7_485,
          cacheRead: 1_323_520,
          total: 1_828_725,
        },
      }),
    ).toBe(158_653);
  });

  it("prefers the explicit context snapshot over aggregate billing buckets", () => {
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 12,
          output: 15_104,
          cacheRead: 819_661,
          cacheWrite: 93_130,
          contextUsage: {
            state: "available",
            promptTokens: 148_874,
            totalTokens: 163_978,
          },
          total: 927_907,
        },
      }),
    ).toBe(148_874);
  });

  it("does not store aggregate billing as session context when the snapshot is unavailable", () => {
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 12,
          output: 15_104,
          cacheRead: 819_661,
          cacheWrite: 93_130,
          contextUsage: { state: "unavailable" },
          total: 927_907,
        },
      }),
    ).toBeUndefined();
  });

  it("includes cache tokens in total calculation", () => {
    const totalTokens = deriveSessionTotalTokens({
      usage: {
        input: 1000,
        cacheRead: 500,
        cacheWrite: 200,
      },
      contextTokens: 4000,
    });
    expect(totalTokens).toBe(1700); // 1000 + 500 + 200
  });

  it("prefers promptTokens override over derived total", () => {
    const totalTokens = deriveSessionTotalTokens({
      usage: {
        input: 1000,
        cacheRead: 500,
        cacheWrite: 200,
      },
      contextTokens: 4000,
      promptTokens: 2500, // Override
    });
    expect(totalTokens).toBe(2500);
  });
});
