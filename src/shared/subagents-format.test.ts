// Subagent format tests cover concise subagent status and duration formatting.
import { describe, expect, it } from "vitest";
import {
  formatDurationCompact,
  formatTokenUsageDisplay,
  resolveTotalTokens,
  truncateLine,
} from "./subagents-format.js";

describe("shared/subagents-format", () => {
  it("re-exports the canonical formatter with second-level precision", () => {
    expect(formatDurationCompact()).toBeUndefined();
    expect(formatDurationCompact(30_000)).toBe("30s");
    expect(formatDurationCompact(90_000)).toBe("1m30s");
    expect(formatDurationCompact(60 * 60_000)).toBe("1h");
    expect(formatDurationCompact(61 * 60_000)).toBe("1h1m");
    expect(formatDurationCompact(24 * 60 * 60_000)).toBe("1d");
    expect(formatDurationCompact(25 * 60 * 60_000)).toBe("1d1h");
  });

  it("formats token counts with integer, kilo, and million branches", () => {
    expect(formatTokenUsageDisplay()).toBe("");
    expect(formatTokenUsageDisplay({ totalTokens: 999.9 })).toBe("tokens 999 prompt/cache");
    expect(formatTokenUsageDisplay({ totalTokens: 1_500 })).toBe("tokens 1.5k prompt/cache");
    expect(formatTokenUsageDisplay({ totalTokens: 10_000 })).toBe("tokens 10k prompt/cache");
    expect(formatTokenUsageDisplay({ totalTokens: 15_400 })).toBe("tokens 15k prompt/cache");
    // Rollover boundary: rounding to thousands must not emit an out-of-scheme
    // "1000k" — it has to advance to the million branch.
    expect(formatTokenUsageDisplay({ totalTokens: 999_499 })).toBe("tokens 999k prompt/cache");
    expect(formatTokenUsageDisplay({ totalTokens: 999_500 })).toBe("tokens 1m prompt/cache");
    expect(formatTokenUsageDisplay({ totalTokens: 999_999 })).toBe("tokens 1m prompt/cache");
    expect(formatTokenUsageDisplay({ totalTokens: 1_000_000 })).toBe("tokens 1m prompt/cache");
    expect(formatTokenUsageDisplay({ totalTokens: 1_250_000 })).toBe("tokens 1.3m prompt/cache");
  });

  it("truncates lines only when needed", () => {
    expect(truncateLine("short", 10)).toBe("short");
    expect(truncateLine("abc   ", 5)).toBe("abc");
    expect(truncateLine("trim me   ", 7)).toBe("trim me");
    expect(truncateLine("abcdefghij", 5)).toBe("ab...");
  });

  it("keeps truncated lines within the requested max length", () => {
    for (const maxLength of [0, 1, 2, 3, 4, 5, 7, 12]) {
      const result = truncateLine("abcdefghij", maxLength);
      expect(result.length).toBeLessThanOrEqual(maxLength);
    }
    expect(truncateLine("abcdefghij", 0)).toBe("");
    expect(truncateLine("abcdefghij", 1)).toBe(".");
    expect(truncateLine("abcdefghij", 2)).toBe("..");
    expect(truncateLine("abcdefghij", 3)).toBe("...");
  });

  it("truncates without breaking surrogate pairs", () => {
    // Emoji at the cut point: the surrogate pair must not be split.
    expect(truncateLine("AB🤖CDEF", 6)).toBe("AB...");
    // Cut point in the middle of a 3-emoji string.
    expect(truncateLine("🤖🤖🤖", 5)).toBe("🤖...");
    // CJK Extension B (surrogate pair) at boundary: character stays intact.
    expect(truncateLine("AB𠮷CDEF", 7)).toBe("AB𠮷...");
    // No broken surrogates in output.
    for (const result of [
      truncateLine("AB🤖CDEF", 6),
      truncateLine("🤖🤖🤖", 5),
      truncateLine("AB𠮷CDEF", 7),
    ]) {
      expect(result).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    }
  });

  it("resolves token totals and io breakdowns from valid numeric fields only", () => {
    expect(resolveTotalTokens()).toBeUndefined();
    expect(resolveTotalTokens({ totalTokens: 42 })).toBe(42);
    expect(resolveTotalTokens({ inputTokens: 10, outputTokens: 5 })).toBe(15);
    expect(resolveTotalTokens({ inputTokens: Number.NaN, outputTokens: 5 })).toBeUndefined();

    expect(formatTokenUsageDisplay({ inputTokens: 10, outputTokens: 5 })).toBe(
      "tokens 15 (in 10 / out 5)",
    );
    expect(formatTokenUsageDisplay({ outputTokens: 5 })).toBe("tokens 5 (in 0 / out 5)");
    expect(formatTokenUsageDisplay({ inputTokens: Number.NaN, outputTokens: 0 })).toBe("");
  });

  it("formats io and prompt-cache usage displays with fallback branches", () => {
    expect(
      formatTokenUsageDisplay({
        inputTokens: 1_200,
        outputTokens: 300,
        totalTokens: 2_100,
      }),
    ).toBe("tokens 1.5k (in 1.2k / out 300), prompt/cache 2.1k");

    expect(formatTokenUsageDisplay({ totalTokens: 500 })).toBe("tokens 500 prompt/cache");
    expect(
      formatTokenUsageDisplay({
        inputTokens: 1_200,
        outputTokens: 300,
        totalTokens: 1_500,
      }),
    ).toBe("tokens 1.5k (in 1.2k / out 300)");
    expect(formatTokenUsageDisplay({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBe("");
  });
});
