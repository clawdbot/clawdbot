import { describe, expect, it } from "vitest";
import { calculateCost, clampThinkingLevel, getSupportedThinkingLevels } from "./model-utils.js";
import type { Model } from "./types.js";

function makeModel(
  thinkingLevelMap: Model["thinkingLevelMap"],
  overrides: Partial<Model> = {},
): Model {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://example.com",
    reasoning: true,
    thinkingLevelMap,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
    ...overrides,
  };
}

describe("calculateCost", () => {
  it.each([
    { cacheWrite1h: undefined, expectedWrite: 0.00012 },
    { cacheWrite1h: -1, expectedWrite: 0.00012 },
    { cacheWrite1h: 40, expectedWrite: 0.00028 },
    { cacheWrite1h: 500, expectedWrite: 0.00036 },
  ])(
    "mutates cost using the prompt tier and bounded 1h writes ($cacheWrite1h)",
    ({ cacheWrite1h, expectedWrite }) => {
      const baseRates = { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 };
      const cost = {
        ...baseRates,
        tieredPricing: [
          { ...baseRates, range: [0, 100] as [number, number] },
          { input: 3, output: 6, cacheRead: 1, cacheWrite: 2, range: [100] as [number] },
        ],
      };
      const usage = {
        input: 20,
        output: 10,
        cacheRead: 30,
        cacheWrite: 60,
        cacheWrite1h,
        totalTokens: 120,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const result = calculateCost(makeModel(undefined, { cost }), usage);
      expect(result).toBe(usage.cost);
      expect(result.input).toBeCloseTo(0.00006, 10);
      expect(result.output).toBeCloseTo(0.00006, 10);
      expect(result.cacheRead).toBeCloseTo(0.00003, 10);
      expect(result.cacheWrite).toBeCloseTo(expectedWrite, 10);
      expect(result.total).toBeCloseTo(0.00015 + expectedWrite, 10);
    },
  );
});

describe("clampThinkingLevel", () => {
  it("downgrades explicit extended-level opt-outs", () => {
    expect(clampThinkingLevel(makeModel({ xhigh: null, max: "max" }), "xhigh")).toBe("high");
  });

  it("keeps upward clamping for lower-level map holes", () => {
    expect(clampThinkingLevel(makeModel({ minimal: null }), "minimal")).toBe("low");
  });

  it("honors canonical Fable capabilities when catalog reasoning is stale", () => {
    const model = makeModel(undefined, {
      id: "company-fable",
      api: "anthropic-messages",
      provider: "microsoft-foundry",
      reasoning: false,
      params: { canonicalModelId: "claude-fable-5" },
    });

    expect(getSupportedThinkingLevels(model)).toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("max");
  });
});
