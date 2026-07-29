// Status format tests cover compact token and prompt-cache display helpers.
import { describe, expect, it } from "vitest";
import { formatKTokens, formatPromptCacheCompact, formatTokensCompact } from "./status.format.js";

describe("status cache formatting", () => {
  it("formats explicit cache details for verbose status output", () => {
    expect(
      formatPromptCacheCompact({
        inputTokens: 2_000,
        cacheRead: 2_000,
        cacheWrite: 1_000,
        totalTokens: 5_000,
      }),
    ).toBe("40% hit · read 2.0k · write 1.0k");
  });

  it("shows cache writes even before there is a cache hit", () => {
    expect(
      formatPromptCacheCompact({
        inputTokens: 2_000,
        cacheRead: 0,
        cacheWrite: 1_000,
        totalTokens: 3_000,
      }),
    ).toBe("0% hit · write 1.0k");
  });

  it("keeps the compact token suffix aligned with prompt-side cache math", () => {
    expect(
      formatTokensCompact({
        inputTokens: 500,
        cacheRead: 2_000,
        cacheWrite: 500,
        totalTokens: 5_000,
        contextTokens: 10_000,
        percentUsed: 50,
      }),
    ).toBe("5.0k/10k (50%) · 🗄️ 67% cached");
  });

  it("renders sub-1000 token counts as plain integers, not fractional k", () => {
    expect(formatKTokens(0)).toBe("0");
    expect(formatKTokens(420)).toBe("420");
    // 999 must not round up across the boundary into a misleading "1.0k".
    expect(formatKTokens(999)).toBe("999");
    expect(formatKTokens(1_000)).toBe("1.0k");
    expect(formatKTokens(12_000)).toBe("12k");
    expect(formatKTokens(999_500)).toBe("1.0m");
  });

  it("keeps small sessions and cache writes readable in status output", () => {
    expect(
      formatTokensCompact({
        inputTokens: 120,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 420,
        contextTokens: 200_000,
        percentUsed: 0,
      }),
    ).toBe("420/200k (0%)");
    expect(
      formatPromptCacheCompact({
        inputTokens: 9_000,
        cacheRead: 12_000,
        cacheWrite: 300,
        totalTokens: 21_300,
      }),
    ).toBe("56% hit · read 12k · write 300");
  });
});
