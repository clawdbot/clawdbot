// Service-tier pricing has exactly one owner. A transport-local copy of this
// table previously drifted (flat 2x priority while gpt-5.5 priority is 2.5x),
// silently understating UI cost for managed-transport turns.
import { describe, expect, it } from "vitest";
import type { Usage } from "../types.js";
import { applyResponsesServiceTierPricing } from "./openai-responses-shared.js";

function usage(): Usage {
  return {
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 110,
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25, total: 3.75 },
  };
}

describe("applyResponsesServiceTierPricing", () => {
  it.each([
    ["default tier keeps base pricing", undefined, "gpt-5.5", 3.75],
    ["flex halves cost", "flex", "gpt-5.5", 1.875],
    ["priority doubles cost for most models", "priority", "gpt-5.6-luna", 7.5],
    ["priority is 2.5x for gpt-5.5", "priority", "gpt-5.5", 9.375],
  ] as const)("%s", (_name, tier, modelId, expectedTotal) => {
    const value = usage();
    applyResponsesServiceTierPricing(value, tier, { id: modelId });
    expect(value.cost.total).toBeCloseTo(expectedTotal, 10);
  });
});
