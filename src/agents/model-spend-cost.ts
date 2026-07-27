import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import { MICRO_USD_PER_USD } from "../utils/micro-usd.js";
import {
  type ModelCostRates,
  resolveModelCostConfig,
  resolveUsageCostRates,
} from "../utils/usage-format.js";
import { resolveAgentDir } from "./agent-scope-config.js";
import { normalizeUsage, type UsageLike } from "./usage.js";

type ResolvedModelSpendCost = {
  costMicroUsd: number;
  costNanoUsdRemainder: number;
  trackingComplete: boolean;
};

function splitUsdCost(
  value: number,
): Pick<ResolvedModelSpendCost, "costMicroUsd" | "costNanoUsdRemainder"> {
  const scaledMicroUsd = value * MICRO_USD_PER_USD;
  let costMicroUsd = Math.floor(scaledMicroUsd);
  let costNanoUsdRemainder = Math.round((scaledMicroUsd - costMicroUsd) * 1_000);
  if (costNanoUsdRemainder === 1_000) {
    costMicroUsd += 1;
    costNanoUsdRemainder = 0;
  }
  if (
    !Number.isSafeInteger(costMicroUsd) ||
    costMicroUsd < 0 ||
    !Number.isSafeInteger(costNanoUsdRemainder) ||
    costNanoUsdRemainder < 0 ||
    costNanoUsdRemainder >= 1_000
  ) {
    throw new Error(`model-spend USD value is outside the supported range: ${value}`);
  }
  return { costMicroUsd, costNanoUsdRemainder };
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
    return { ...splitUsdCost(providerBilledTotal), trackingComplete: true };
  }

  const usage = normalizeUsage(params.usage);
  if (!usage) {
    return { costMicroUsd: 0, costNanoUsdRemainder: 0, trackingComplete: false };
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
  const rates: ModelCostRates | undefined = resolveUsageCostRates({ usage, cost });
  const pricedBuckets = [
    { tokens: usage.input, rate: rates?.input },
    { tokens: usage.output, rate: rates?.output },
    { tokens: usage.cacheRead, rate: rates?.cacheRead },
    { tokens: usage.cacheWrite, rate: rates?.cacheWrite },
  ];
  const pricingComplete =
    rates !== undefined &&
    pricedBuckets.every(
      (bucket) =>
        (bucket.tokens ?? 0) <= 0 ||
        (typeof bucket.rate === "number" && Number.isFinite(bucket.rate) && bucket.rate > 0),
    );
  const knownUsd = pricedBuckets.reduce((total, bucket) => {
    const tokens = bucket.tokens ?? 0;
    return tokens > 0 &&
      typeof bucket.rate === "number" &&
      Number.isFinite(bucket.rate) &&
      bucket.rate > 0
      ? total + (tokens * bucket.rate) / 1_000_000
      : total;
  }, 0);
  return {
    ...splitUsdCost(knownUsd),
    trackingComplete: usageComplete && pricingComplete,
  };
}
