/** One normalized tier in a per-million-token pricing schedule. */
export type PricingTier = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Half-open input-token interval `[start, end)`. */
  range: [number, number];
};

type RawPricingTier = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  range: [number, number] | [number];
};

/** Per-million-token pricing used by usage summaries and cost estimates. */
export type ModelCostConfig = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tieredPricing?: PricingTier[];
};

export type RawModelCostConfig = Omit<ModelCostConfig, "tieredPricing"> & {
  tieredPricing?: RawPricingTier[];
};

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

export function normalizeResolvedPricing(cost: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tieredPricing?: RawPricingTier[];
}): ModelCostConfig {
  const finiteOrZero = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return normalizeModelCostConfig({
    input: finiteOrZero(cost.input),
    output: finiteOrZero(cost.output),
    cacheRead: finiteOrZero(cost.cacheRead),
    cacheWrite: finiteOrZero(cost.cacheWrite),
    ...(cost.tieredPricing ? { tieredPricing: cost.tieredPricing } : {}),
  });
}
