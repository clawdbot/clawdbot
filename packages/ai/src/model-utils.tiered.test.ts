import { describe, expect, it } from "vitest";
import { calculateCost } from "./model-utils.js";
import type { Model, Usage } from "./types.js";

describe("calculateCost tiered pricing", () => {
  it("uses the matching input tier for long-context usage", () => {
    const model = {
      id: "gpt-5.4",
      name: "GPT 5.4",
      api: "anthropic-messages",
      provider: "vercel-ai-gateway",
      baseUrl: "https://ai-gateway.vercel.sh",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 2.5,
        output: 15,
        cacheRead: 0.25,
        cacheWrite: 0,
        tieredPricing: [
          { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0, range: [0, 272_000] },
          { input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0, range: [272_000] },
        ],
      },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    } as unknown as Model;
    const usage = {
      input: 300_000,
      output: 1_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 301_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } satisfies Usage;

    calculateCost(model, usage);

    expect(usage.cost.input).toBeCloseTo(1.5);
    expect(usage.cost.output).toBeCloseTo(0.0225);
    expect(usage.cost.total).toBeCloseTo(1.5225);
  });

  it("normalizes unordered and gapped tier declarations", () => {
    const model = {
      cost: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        tieredPricing: [
          { input: 3, output: 3, cacheRead: 0, cacheWrite: 0, range: [500_000] },
          { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, range: [0, 100_000] },
        ],
      },
    } as unknown as Model;
    const usage = {
      input: 50_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 50_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } satisfies Usage;

    calculateCost(model, usage);

    expect(usage.cost.input).toBeCloseTo(0.05);
  });

  it("prices independently billed compaction iterations before aggregation", () => {
    const model = {
      cost: {
        input: 2.5,
        output: 15,
        cacheRead: 0.25,
        cacheWrite: 0,
        tieredPricing: [
          { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0, range: [0, 272_000] },
          { input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0, range: [272_000] },
        ],
      },
    } as unknown as Model;
    const usage = {
      input: 400_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 400_000,
      costByIteration: [
        { input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 },
        { input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      ],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } satisfies Usage;

    calculateCost(model, usage);

    expect(usage.cost.input).toBeCloseTo(1);
    expect(usage.cost.total).toBeCloseTo(1);
    expect(usage.costByIteration).toBeUndefined();
  });
});
