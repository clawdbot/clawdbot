// Status format tests cover compact token and prompt-cache display helpers.
import { describe, expect, it } from "vitest";
import { formatPromptCacheCompact, formatTokensCompact } from "./status.format.js";

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
});
