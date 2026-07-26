import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import { MICRO_USD_PER_USD } from "../utils/micro-usd.js";
import {
  estimateUsageCost,
  type ModelCostRates,
  resolveModelCostConfig,
  resolveUsageCostRates,
} from "../utils/usage-format.js";
import { resolveAgentDir } from "./agent-scope-config.js";
import { normalizeUsage, type UsageLike } from "./usage.js";

type ResolvedModelSpendCost = {
  costMicroUsd: number;
  trackingComplete: boolean;
};

function ceilUsdToMicroUsd(value: number): number {
  const microUsd = Math.ceil(value * MICRO_USD_PER_USD);
  if (!Number.isSafeInteger(microUsd) || microUsd < 0) {
    throw new Error(`model-spend USD value is outside the supported range: ${value}`);
  }
  return microUsd;
}

export function resolveModelSpendCostMicroUsd(params: {
  model: Model;
  usage?: UsageLike;
  cfg?: OpenClawConfig;
  agentId?: string;
}): ResolvedModelSpendCost {
  const providerBilledTotal = params.usage?.cost?.total;
  if (
    params.usage?.cost?.totalOrigin === "provider-billed" &&
    typeof providerBilledTotal === "number" &&
    Number.isFinite(providerBilledTotal) &&
    providerBilledTotal >= 0
  ) {
    return { costMicroUsd: ceilUsdToMicroUsd(providerBilledTotal), trackingComplete: true };
  }

  const usage = normalizeUsage(params.usage);
  if (!usage) {
    return { costMicroUsd: 0, trackingComplete: false };
  }
  const buckets = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  const knownTokenTotal = buckets.reduce<number>((sum, bucket) => sum + (bucket ?? 0), 0);
  const allBucketsKnown = buckets.every((bucket) => bucket !== undefined);
  const totalReconciles = usage.total !== undefined && usage.total === knownTokenTotal;
  const usageComplete =
    (allBucketsKnown || totalReconciles) && (usage.total === undefined || totalReconciles);
  const resolvedCost = params.cfg
    ? resolveModelCostConfig({
        provider: params.model.provider,
        model: params.model.id,
        config: params.cfg,
        ...(params.agentId ? { agentDir: resolveAgentDir(params.cfg, params.agentId) } : {}),
      })
    : undefined;
  const cost = resolvedCost ?? params.model.cost;
  const usd = estimateUsageCost({ usage, cost });
  const rates: ModelCostRates | undefined = resolveUsageCostRates({ usage, cost });
  const pricingComplete =
    rates !== undefined &&
    usd !== undefined &&
    usd >= 0 &&
    [
      { tokens: usage.input, rate: rates.input },
      { tokens: usage.output, rate: rates.output },
      { tokens: usage.cacheRead, rate: rates.cacheRead },
      { tokens: usage.cacheWrite, rate: rates.cacheWrite },
    ].every(
      (bucket) => (bucket.tokens ?? 0) <= 0 || (Number.isFinite(bucket.rate) && bucket.rate > 0),
    );
  return {
    costMicroUsd: ceilUsdToMicroUsd(pricingComplete ? usd : 0),
    trackingComplete: usageComplete && pricingComplete,
  };
}
