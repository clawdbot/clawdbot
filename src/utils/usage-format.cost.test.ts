import { describe, expect, it } from "vitest";
import {
  estimateAggregateUsageCost,
  estimateUsageCost,
  type ModelCostConfig,
} from "./usage-format.js";

type PricingTier = NonNullable<ModelCostConfig["tieredPricing"]>[number];

describe("usage cost estimation", () => {
  it("uses flat pricing when tieredPricing is absent", () => {
    const cost = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 };
    const total = estimateUsageCost({
      usage: { input: 1000, output: 500, cacheRead: 2000 },
      cost,
    });
    expect(total).toBeCloseTo(0.003);
  });

  it.each([
    {
      name: "recorded total",
      usage: { input: 1_000, cost: { total: 0.75 } },
      tiered: true,
      expected: 0.75,
    },
    {
      name: "recorded zero",
      usage: { input: 1_000, cost: { total: 0 } },
      tiered: true,
      expected: 0,
    },
    { name: "cost-only fact", usage: { cost: { total: 0.75 } }, tiered: true, expected: 0.75 },
    { name: "missing tiered cost", usage: { input: 1_000 }, tiered: true, expected: undefined },
    { name: "flat fallback", usage: { input: 1_000 }, tiered: false, expected: 0.001 },
    { name: "total-only usage", usage: { total: 1_000 }, tiered: false, expected: undefined },
    { name: "empty usage", usage: {}, tiered: false, expected: undefined },
  ])(
    "resolves aggregate cost without reconstructing call tiers: $name",
    ({ usage, tiered, expected }) => {
      const rates = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 };
      const cost: ModelCostConfig = {
        ...rates,
        ...(tiered
          ? { tieredPricing: [{ ...rates, range: [0, Infinity] as [number, number] }] }
          : {}),
      };
      expect(estimateAggregateUsageCost({ usage, cost })).toBe(expected);
    },
  );

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

  it.each([
    { name: "below boundary", input: 40, cacheRead: 30, cacheWrite: 29, expected: 0.000082 },
    { name: "at boundary", input: 40, cacheRead: 30, cacheWrite: 30, expected: 0.00027 },
    { name: "above boundary", input: 40, cacheRead: 30, cacheWrite: 31, expected: 0.000272 },
    { name: "fully cached", input: 0, cacheRead: 100, cacheWrite: 0, expected: 0.00016 },
    { name: "fully written", input: 0, cacheRead: 0, cacheWrite: 100, expected: 0.00026 },
  ])(
    "selects the whole-request tier from prompt buckets: $name",
    ({ input, cacheRead, cacheWrite, expected }) => {
      const baseRates = { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 };
      const cost: ModelCostConfig = {
        ...baseRates,
        tieredPricing: [
          { ...baseRates, range: [0, 100] },
          { input: 3, output: 6, cacheRead: 1, cacheWrite: 2, range: [100, Infinity] },
        ],
      };
      expect(
        estimateUsageCost({ usage: { input, output: 10, cacheRead, cacheWrite }, cost }),
      ).toBeCloseTo(expected, 10);
    },
  );

  it("uses the selected input rate for the 1h cache-write subset", () => {
    const baseRates = { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 };
    const cost: ModelCostConfig = {
      ...baseRates,
      tieredPricing: [
        { ...baseRates, range: [0, 100] },
        { input: 3, output: 6, cacheRead: 1, cacheWrite: 2, range: [100, Infinity] },
      ],
    };
    const usage = { input: 20, output: 10, cacheRead: 30, cacheWrite: 60, cacheWrite1h: 40 };
    expect(estimateUsageCost({ usage, cost })).toBeCloseTo(0.00043, 10);
  });

  it("estimates cost with three tiers — volcengine-style pricing", () => {
    // Simulates volcengine/doubao pricing (per-million):
    // Tier 1: [0, 32000) → in $0.46, out $2.30
    // Tier 2: [32000, 128000) → in $0.70, out $3.50
    // Tier 3: [128000, 256000) → in $1.40, out $7.00
    const tiers: PricingTier[] = [
      { input: 0.46, output: 2.3, cacheRead: 0, cacheWrite: 0, range: [0, 32_000] },
      { input: 0.7, output: 3.5, cacheRead: 0, cacheWrite: 0, range: [32_000, 128_000] },
      { input: 1.4, output: 7, cacheRead: 0, cacheWrite: 0, range: [128_000, 256_000] },
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
      { input: 1, output: 3, cacheRead: 0.5, cacheWrite: 0, range: [0, 30_000] },
    ];
    const cost = { input: 1, output: 3, cacheRead: 0.5, cacheWrite: 0, tieredPricing: tiers };

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
});
