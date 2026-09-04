// Memory Core tests cover flush plan plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMemoryFlushPlan } from "./flush-plan.js";

describe("buildMemoryFlushPlan", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back when the injected timestamp is outside Date range", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));

    const plan = buildMemoryFlushPlan({
      nowMs: 8_640_000_000_000_001,
    });

    expect(plan?.relativePath).toBe("memory/2026-05-30.md");
  });

  it("carries declared flush fallbacks and keeps the exact override by default", () => {
    const withFallbacks = buildMemoryFlushPlan({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                model: "ollama/qwen3:8b",
                fallbacks: ["anthropic/claude-haiku-4-5", "  ", "openai/gpt-5.4"],
              },
            },
          },
        },
      },
    });
    // Blank refs are dropped; order is preserved.
    expect(withFallbacks?.fallbacks).toEqual([
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5.4",
    ]);

    // Omitted, empty, and all-blank lists all keep the exact-override default,
    // so an unreachable maintenance model never silently bills the paid model.
    for (const fallbacks of [undefined, [], ["", "   "]]) {
      expect(
        buildMemoryFlushPlan({
          cfg: {
            agents: {
              defaults: {
                compaction: { memoryFlush: { model: "ollama/qwen3:8b", fallbacks } },
              },
            },
          },
        })?.fallbacks,
      ).toBeUndefined();
    }
  });

  it.each([
    [8_000, 2_000, 3_000],
    [16_000, 4_000, 4_000],
    [24_000, 6_000, 4_000],
    [32_768, 8_192, 4_000],
    [128_000, 20_000, 4_000],
    [200_000, 20_000, 4_000],
  ])(
    "sizes its reserve and maintenance headroom to a %i-token context window",
    (contextWindowTokens, reserveTokensFloor, softThresholdTokens) => {
      expect(buildMemoryFlushPlan({ contextWindowTokens })).toMatchObject({
        reserveTokensFloor,
        softThresholdTokens,
      });
    },
  );
});
