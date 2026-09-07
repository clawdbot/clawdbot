import type {
  ModelCostConfig,
  ModelCostRates,
  PricingTier,
  RawModelCostConfig,
  RawPricingTier,
  Usage,
} from "./types.js";

// Pricing is a model snapshot. Weak keys release the sorted schedule with its owner;
// a config/catalog reload supplies a new schedule rather than mutating active tiers.
const sortedPricingTiers = new WeakMap<RawPricingTier[], PricingTier[]>();

const finiteOrZero = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function normalizeTieredPricing(raw: RawPricingTier[] | undefined): PricingTier[] | undefined {
  if (!raw || raw.length === 0) {
    return undefined;
  }
  const result: PricingTier[] = [];
  for (const tier of raw) {
    const range = tier.range;
    const start = Array.isArray(range) && typeof range[0] === "number" ? range[0] : Number.NaN;
    if (!Number.isFinite(start)) {
      continue;
    }
    const rawEnd = range.length >= 2 ? range[1] : null;
    const end =
      typeof rawEnd === "number" && Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : Infinity;
    if (
      !Number.isFinite(tier.input) ||
      !Number.isFinite(tier.output) ||
      !Number.isFinite(tier.cacheRead) ||
      !Number.isFinite(tier.cacheWrite)
    ) {
      continue;
    }
    result.push({
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cacheRead,
      cacheWrite: tier.cacheWrite,
      range: [start, end],
    });
  }
  return result.length > 0 ? result.toSorted((a, b) => a.range[0] - b.range[0]) : undefined;
}

export function normalizeModelCostConfig(cost: RawModelCostConfig): ModelCostConfig {
  const normalizedTiers = normalizeTieredPricing(cost.tieredPricing);
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    ...(normalizedTiers ? { tieredPricing: normalizedTiers } : {}),
  };
}

export function normalizeResolvedPricing(cost: Partial<RawModelCostConfig>): ModelCostConfig {
  return normalizeModelCostConfig({
    input: finiteOrZero(cost.input),
    output: finiteOrZero(cost.output),
    cacheRead: finiteOrZero(cost.cacheRead),
    cacheWrite: finiteOrZero(cost.cacheWrite),
    ...(cost.tieredPricing ? { tieredPricing: cost.tieredPricing } : {}),
  });
}

function selectPricingRates(cost: RawModelCostConfig, promptTokens: number): ModelCostRates {
  const tiers = cost.tieredPricing;
  if (!tiers?.length) {
    return cost;
  }
  let sorted = sortedPricingTiers.get(tiers);
  if (!sorted) {
    sorted = normalizeTieredPricing(tiers) ?? [];
    sortedPricingTiers.set(tiers, sorted);
  }
  if (promptTokens <= 0) {
    return sorted[0] ?? cost;
  }
  const matched = sorted.find(
    (tier) => promptTokens >= tier.range[0] && promptTokens < tier.range[1],
  );
  // Preserve whole-request pricing for gaps and overflow: nearest lower tier,
  // otherwise the first tier. Never blend the buckets across tiers.
  return matched ?? sorted.findLast((tier) => promptTokens >= tier.range[0]) ?? sorted[0] ?? cost;
}

/** Price one model call, selecting its tier before billing the separate token buckets. */
export function calculateUsageCost(
  usage: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h">>,
  pricing: RawModelCostConfig,
): Usage["cost"] {
  const input = finiteOrZero(usage.input);
  const output = finiteOrZero(usage.output);
  const cacheRead = finiteOrZero(usage.cacheRead);
  const cacheWrite = finiteOrZero(usage.cacheWrite);
  const rates = selectPricingRates(pricing, input + cacheRead + cacheWrite);
  const cacheWrite1h = Math.min(cacheWrite, Math.max(0, finiteOrZero(usage.cacheWrite1h)));
  const cacheWrite5m = cacheWrite - cacheWrite1h;
  const cost = {
    input: (input * rates.input) / 1_000_000,
    output: (output * rates.output) / 1_000_000,
    cacheRead: (cacheRead * rates.cacheRead) / 1_000_000,
    // One-hour writes are a subset, priced at twice the selected input rate.
    cacheWrite: (cacheWrite5m * rates.cacheWrite + cacheWrite1h * rates.input * 2) / 1_000_000,
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return cost;
}
