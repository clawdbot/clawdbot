import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  __resetGatewayModelPricingCacheForTest,
  __setGatewayModelPricingForTest,
} from "../gateway/model-pricing-cache-state.js";
import {
  __resetUsageFormatCachesForTest,
  estimateUsageCost,
  formatTokenCount,
  formatUsd,
  resolveModelCostConfig,
  type PricingTier,
} from "./usage-format.js";

describe("usage-format", () => {
  const originalAgentDir = process.env.OPENCLAW_AGENT_DIR;
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-format-"));
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    __resetUsageFormatCachesForTest();
    __resetGatewayModelPricingCacheForTest();
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = originalAgentDir;
    }
    __resetUsageFormatCachesForTest();
    __resetGatewayModelPricingCacheForTest();
    await fs.rm(agentDir, { recursive: true, force: true });
  });

  it("formats token counts", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(12000)).toBe("12k");
    expect(formatTokenCount(999_499)).toBe("999k");
    expect(formatTokenCount(999_500)).toBe("1.0m");
    expect(formatTokenCount(2_500_000)).toBe("2.5m");
  });

  it("formats USD values", () => {
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(0.0042)).toBe("$0.0042");
  });

  it("resolves model cost config and estimates usage cost", () => {
    const config = {
      models: {
        providers: {
          test: {
            models: [
              {
                id: "m1",
                cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const cost = resolveModelCostConfig({
      provider: "test",
      model: "m1",
      config,
    });

    expect(cost).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 0,
    });

    const total = estimateUsageCost({
      usage: { input: 1000, output: 500, cacheRead: 2000 },
      cost,
    });

    expect(total).toBeCloseTo(0.003);
  });

  it("returns undefined when model pricing is not configured", () => {
    expect(
      resolveModelCostConfig({
        provider: "demo-unconfigured-a",
        model: "demo-model-a",
      }),
    ).toBeUndefined();

    expect(
      resolveModelCostConfig({
        provider: "demo-unconfigured-b",
        model: "demo-model-b",
      }),
    ).toBeUndefined();
  });

  it("prefers models.json pricing over openclaw config and cached pricing", async () => {
    const config = {
      models: {
        providers: {
          "demo-preferred": {
            models: [
              {
                id: "demo-model",
                cost: { input: 20, output: 21, cacheRead: 22, cacheWrite: 23 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            "demo-preferred": {
              models: [
                {
                  id: "demo-model",
                  cost: { input: 10, output: 11, cacheRead: 12, cacheWrite: 13 },
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    __setGatewayModelPricingForTest([
      {
        provider: "demo-preferred",
        model: "demo-model",
        pricing: { input: 30, output: 31, cacheRead: 32, cacheWrite: 33 },
      },
    ]);

    expect(
      resolveModelCostConfig({
        provider: "demo-preferred",
        model: "demo-model",
        config,
      }),
    ).toEqual({
      input: 10,
      output: 11,
      cacheRead: 12,
      cacheWrite: 13,
    });
  });

  it("falls back to openclaw config pricing when models.json is absent", () => {
    const config = {
      models: {
        providers: {
          "demo-config-provider": {
            models: [
              {
                id: "demo-model",
                cost: { input: 9, output: 19, cacheRead: 0.9, cacheWrite: 1.9 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    __setGatewayModelPricingForTest([
      {
        provider: "demo-config-provider",
        model: "demo-model",
        pricing: { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0.4 },
      },
    ]);

    expect(
      resolveModelCostConfig({
        provider: "demo-config-provider",
        model: "demo-model",
        config,
      }),
    ).toEqual({
      input: 9,
      output: 19,
      cacheRead: 0.9,
      cacheWrite: 1.9,
    });
  });

  it("falls back to cached gateway pricing when no configured cost exists", () => {
    __setGatewayModelPricingForTest([
      {
        provider: "demo-cached-provider",
        model: "demo-model",
        pricing: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
      },
    ]);

    expect(
      resolveModelCostConfig({
        provider: "demo-cached-provider",
        model: "demo-model",
      }),
    ).toEqual({
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 0,
    });
  });

  it("can skip plugin-backed model normalization for display-only cost lookup", () => {
    const config = {
      models: {
        providers: {
          "google-vertex": {
            models: [
              {
                id: "gemini-3.1-flash-lite",
                cost: { input: 7, output: 8, cacheRead: 0.7, cacheWrite: 0.8 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelCostConfig({
        provider: "google-vertex",
        model: "gemini-3.1-flash-lite",
        config,
        allowPluginNormalization: false,
      }),
    ).toEqual({
      input: 7,
      output: 8,
      cacheRead: 0.7,
      cacheWrite: 0.8,
    });
  });

  // -----------------------------------------------------------------------
  // Tiered pricing tests
  // -----------------------------------------------------------------------

  it("uses flat pricing when tieredPricing is absent", () => {
    const cost = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 };
    const total = estimateUsageCost({
      usage: { input: 1000, output: 500, cacheRead: 2000 },
      cost,
    });
    expect(total).toBeCloseTo(0.003);
  });

  it("estimates cost with single-tier tiered pricing (equivalent to flat)", () => {
    const tiers: PricingTier[] = [
      { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0, range: [0, 1_000_000] },
    ];
    const cost = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0, tieredPricing: tiers };
    const total = estimateUsageCost({
      usage: { input: 1000, output: 500, cacheRead: 2000 },
      cost,
    });
    // Same as flat: (1000*1 + 500*2 + 2000*0.5) / 1M = 3000/1M = 0.003
    expect(total).toBeCloseTo(0.003);
  });

  it("uses the matching context tier instead of blending lower tiers", () => {
    // Tier 1: [0, 32000) → input $0.30/M, output $1.50/M
    // Tier 2: [32000, 128000) → input $0.50/M, output $2.50/M
    const tiers: PricingTier[] = [
      { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, range: [0, 32_000] },
      { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0, range: [32_000, 128_000] },
    ];
    const cost = { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    // 40000 input tokens selects Tier 2 for the whole request:
    // (40000 * 0.5 + 10000 * 2.5) / 1M = 0.045
    const total = estimateUsageCost({
      usage: { input: 40_000, output: 10_000 },
      cost,
    });
    expect(total).toBeCloseTo(0.045, 4);
  });

  it("estimates cost with three tiers — volcengine-style pricing", () => {
    // Simulates volcengine/doubao pricing (per-million):
    // Tier 1: [0, 32000) → in $0.46, out $2.30
    // Tier 2: [32000, 128000) → in $0.70, out $3.50
    // Tier 3: [128000, 256000) → in $1.40, out $7.00
    const tiers: PricingTier[] = [
      { input: 0.46, output: 2.3, cacheRead: 0, cacheWrite: 0, range: [0, 32_000] },
      { input: 0.7, output: 3.5, cacheRead: 0, cacheWrite: 0, range: [32_000, 128_000] },
      { input: 1.4, output: 7.0, cacheRead: 0, cacheWrite: 0, range: [128_000, 256_000] },
    ];
    const cost = { input: 0.46, output: 2.3, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    // 200000 input tokens selects Tier 3 for the whole request:
    // (200000 * 1.40 + 5000 * 7.00) / 1M = 0.315
    const total = estimateUsageCost({
      usage: { input: 200_000, output: 5_000 },
      cost,
    });
    expect(total).toBeCloseTo(0.315, 4);
  });

  it("uses first tier rates for output when input is zero", () => {
    const tiers: PricingTier[] = [
      { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, range: [0, 32_000] },
      { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0, range: [32_000, 128_000] },
    ];
    const cost = { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    const total = estimateUsageCost({
      usage: { input: 0, output: 10_000 },
      cost,
    });
    // Falls back to first tier: 10000 * 1.5 / 1M = 0.015
    expect(total).toBeCloseTo(0.015, 6);
  });

  it("falls back to flat pricing when tieredPricing is empty array", () => {
    const cost = {
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 0,
      tieredPricing: [] as PricingTier[],
    };
    const total = estimateUsageCost({
      usage: { input: 1000, output: 500, cacheRead: 2000 },
      cost,
    });
    expect(total).toBeCloseTo(0.003);
  });

  it("bills overflow input tokens at last tier rate when input exceeds max range", () => {
    // Tiers only cover up to 128000, but input is 200000
    // Tier 1: [0, 32000) → in $0.30/M, out $1.50/M
    // Tier 2: [32000, 128000) → in $0.50/M, out $2.50/M
    // Overflow: 72000 tokens billed at Tier 2 rates
    const tiers: PricingTier[] = [
      { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, range: [0, 32_000] },
      { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0, range: [32_000, 128_000] },
    ];
    const cost = { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    // 200000 input tokens exceeds the max range, so the last tier is the
    // whole-request fallback: (200000 * 0.5 + 10000 * 2.5) / 1M = 0.125
    const total = estimateUsageCost({
      usage: { input: 200_000, output: 10_000 },
      cost,
    });
    expect(total).toBeCloseTo(0.125, 4);
  });

  it("bills overflow at last tier when only a single small-range tier exists (e.g. <30K)", () => {
    // Only one tier covering [0, 30000), input is 100000
    const tiers: PricingTier[] = [
      { input: 1.0, output: 3.0, cacheRead: 0.5, cacheWrite: 0, range: [0, 30_000] },
    ];
    const cost = { input: 1.0, output: 3.0, cacheRead: 0.5, cacheWrite: 0, tieredPricing: tiers };

    // 100000 input exceeds the only range, so Tier 1 is the whole-request fallback.
    // Total = 0.1 + 0.015 + 0.001 = 0.116
    const total = estimateUsageCost({
      usage: { input: 100_000, output: 5_000, cacheRead: 2_000 },
      cost,
    });
    expect(total).toBeCloseTo(0.116, 4);
  });

  it("supports open-ended range [start] in tiered pricing (greater-than syntax)", () => {
    // Tier 1: [0, 32000) → in $0.30/M, out $1.50/M
    // Tier 2: [32000, Infinity) → in $0.50/M, out $2.50/M  (open-ended)
    const tiers: PricingTier[] = [
      { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, range: [0, 32_000] },
      { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0, range: [32_000, Infinity] },
    ];
    const cost = { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    // 200000 input tokens selects the open-ended Tier 2 for the whole request.
    const total = estimateUsageCost({
      usage: { input: 200_000, output: 10_000 },
      cost,
    });
    expect(total).toBeCloseTo(0.125, 4);
  });

  it("uses declared tier ranges instead of sequential widths", () => {
    const tiers: PricingTier[] = [
      { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, range: [100, 200] },
      { input: 2, output: 20, cacheRead: 0, cacheWrite: 0, range: [0, 100] },
    ];
    const cost = { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    const total = estimateUsageCost({
      usage: { input: 150, output: 60 },
      cost,
    });

    expect(total).toBeCloseTo(0.00075, 8);
  });

  it("bills malformed tier gaps at a whole-request fallback tier", () => {
    const tiers: PricingTier[] = [
      { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, range: [0, 50] },
      { input: 3, output: 30, cacheRead: 0, cacheWrite: 0, range: [100, 150] },
    ];
    const cost = { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    const total = estimateUsageCost({
      usage: { input: 150, output: 60 },
      cost,
    });

    expect(total).toBeCloseTo(0.00225, 8);
  });

  it("normalizes open-ended range from models.json ([start] and [start, -1])", async () => {
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            volcengine: {
              models: [
                {
                  id: "doubao-open-ended",
                  cost: {
                    input: 0.46,
                    output: 2.3,
                    cacheRead: 0,
                    cacheWrite: 0,
                    tieredPricing: [
                      { input: 0.46, output: 2.3, cacheRead: 0, cacheWrite: 0, range: [0, 32000] },
                      { input: 0.7, output: 3.5, cacheRead: 0, cacheWrite: 0, range: [32000] },
                    ],
                  },
                },
                {
                  id: "doubao-neg-one",
                  cost: {
                    input: 0.46,
                    output: 2.3,
                    cacheRead: 0,
                    cacheWrite: 0,
                    tieredPricing: [
                      { input: 0.46, output: 2.3, cacheRead: 0, cacheWrite: 0, range: [0, 32000] },
                      { input: 0.7, output: 3.5, cacheRead: 0, cacheWrite: 0, range: [32000, -1] },
                    ],
                  },
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    // [32000] should be normalized to [32000, Infinity]
    const cost1 = resolveModelCostConfig({
      provider: "volcengine",
      model: "doubao-open-ended",
    });
    expect(cost1).toBeDefined();
    expect(cost1!.tieredPricing).toHaveLength(2);
    expect(cost1!.tieredPricing![1].range).toEqual([32000, Infinity]);

    // [32000, -1] should also be normalized to [32000, Infinity]
    const cost2 = resolveModelCostConfig({
      provider: "volcengine",
      model: "doubao-neg-one",
    });
    expect(cost2).toBeDefined();
    expect(cost2!.tieredPricing).toHaveLength(2);
    expect(cost2!.tieredPricing![1].range).toEqual([32000, Infinity]);
  });

  it("resolves tiered pricing from models.json", async () => {
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            volcengine: {
              models: [
                {
                  id: "doubao-seed-2-0-pro",
                  cost: {
                    input: 0.46,
                    output: 2.3,
                    cacheRead: 0,
                    cacheWrite: 0,
                    tieredPricing: [
                      { input: 0.46, output: 2.3, cacheRead: 0, cacheWrite: 0, range: [0, 32000] },
                      {
                        input: 0.7,
                        output: 3.5,
                        cacheRead: 0,
                        cacheWrite: 0,
                        range: [32000, 128000],
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const cost = resolveModelCostConfig({
      provider: "volcengine",
      model: "doubao-seed-2-0-pro",
    });

    expect(cost).toBeDefined();
    expect(cost!.tieredPricing).toHaveLength(2);
    expect(cost!.tieredPricing![0].range).toEqual([0, 32000]);
    expect(cost!.tieredPricing![1].input).toBe(0.7);
  });

  it("resolves tiered pricing from cached gateway (LiteLLM)", () => {
    __setGatewayModelPricingForTest([
      {
        provider: "volcengine",
        model: "doubao-seed",
        pricing: {
          input: 0.46,
          output: 2.3,
          cacheRead: 0,
          cacheWrite: 0,
          tieredPricing: [
            {
              input: 0.46,
              output: 2.3,
              cacheRead: 0,
              cacheWrite: 0,
              range: [0, 32000] as [number, number],
            },
            {
              input: 0.7,
              output: 3.5,
              cacheRead: 0,
              cacheWrite: 0,
              range: [32000, 128000] as [number, number],
            },
          ],
        },
      },
    ]);

    const cost = resolveModelCostConfig({
      provider: "volcengine",
      model: "doubao-seed",
    });

    expect(cost).toBeDefined();
    expect(cost!.tieredPricing).toHaveLength(2);
  });
});
