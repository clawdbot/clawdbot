import { createCodeModeStats, mergeCodeModeStats, type CodeModeStats } from "../code-mode-stats.js";
/**
 * Accumulates and normalizes per-call token usage across embedded runs.
 */
import {
  bindNormalizedUsageObservedBuckets,
  NORMALIZED_USAGE_BUCKET_ORDER,
  resolveNormalizedUsageObservedBuckets,
  type NormalizedUsage,
  type NormalizedUsageBucket,
} from "../usage.js";

export type UsageAccumulator = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningTokens: number;
  total: number;
  observedUsageBuckets: Set<NormalizedUsageBucket>;
  /** Usage-bearing calls merged so exact buckets can require all-call observation. */
  usageObservations: number;
  providerBilledCostUsd: number;
  providerBilledCostReports: number;
  providerBilledCostCompleteReports: number;
  /**
   * Completed assistant round trips across every model attempt of the run.
   * Kept beside token totals so retried attempts stay counted like their usage.
   */
  assistantTurns: number;
  /**
   * Cumulative inner bridge calls across attempts. Present only once an
   * attempt reported a tool-search/code-mode catalog, so catalog-less runs
   * omit the field instead of publishing zero sentinels.
   */
  bridgeCalls?: {
    search: number;
    describe: number;
    call: number;
  };
  /** Cumulative host-side Code Mode accounting across every run attempt. */
  codeModeStats?: CodeModeStats;
};

export const createUsageAccumulator = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoningTokens: 0,
  total: 0,
  observedUsageBuckets: new Set(),
  usageObservations: 0,
  providerBilledCostUsd: 0,
  providerBilledCostReports: 0,
  providerBilledCostCompleteReports: 0,
  assistantTurns: 0,
});

type MaybeUsage = NormalizedUsage | undefined;

const hasUsageValues = (usage: MaybeUsage): usage is NormalizedUsage => {
  if (!usage) {
    return false;
  }
  return (
    resolveNormalizedUsageObservedBuckets(usage).size > 0 ||
    [
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      usage.contextUsage?.state === "available" ? usage.contextUsage.promptTokens : undefined,
      usage.contextUsage?.state === "available" ? usage.contextUsage.totalTokens : undefined,
      usage.reasoningTokens,
      usage.total,
    ].some((value) => typeof value === "number" && Number.isFinite(value) && value > 0) ||
    usage.contextUsage?.state === "unavailable" ||
    usage.providerBilledCost !== undefined
  );
};

export const mergeUsageIntoAccumulator = (target: UsageAccumulator, usage: MaybeUsage) => {
  if (!hasUsageValues(usage)) {
    return;
  }
  const observedBuckets = resolveNormalizedUsageObservedBuckets(usage);
  if (target.usageObservations === 0) {
    for (const bucket of observedBuckets) {
      target.observedUsageBuckets.add(bucket);
    }
  } else {
    for (const bucket of target.observedUsageBuckets) {
      if (!observedBuckets.has(bucket)) {
        target.observedUsageBuckets.delete(bucket);
      }
    }
  }
  target.usageObservations += 1;
  const callTotal =
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.reasoningTokens += usage.reasoningTokens ?? 0;
  target.total += callTotal;
  if (usage.providerBilledCost) {
    target.providerBilledCostUsd += usage.providerBilledCost.totalUsd;
    target.providerBilledCostReports += 1;
    target.providerBilledCostCompleteReports +=
      usage.providerBilledCost.coverage === "complete" ? 1 : 0;
  }
};

/**
 * Folds one attempt's run stats into the accumulator. Attempt cleanup clears
 * the per-attempt tool-search catalog, so retries would otherwise discard
 * earlier bridge counts and undercount the documented cumulative run totals.
 */
export const mergeAttemptRunStatsIntoAccumulator = (
  target: UsageAccumulator,
  attempt: {
    assistantTurns?: number;
    bridgeCalls?: { search: number; describe: number; call: number };
    codeModeStats?: CodeModeStats;
  },
) => {
  target.assistantTurns += attempt.assistantTurns ?? 0;
  if (attempt.bridgeCalls) {
    const bridgeCalls = target.bridgeCalls ?? { search: 0, describe: 0, call: 0 };
    bridgeCalls.search += attempt.bridgeCalls.search;
    bridgeCalls.describe += attempt.bridgeCalls.describe;
    bridgeCalls.call += attempt.bridgeCalls.call;
    target.bridgeCalls = bridgeCalls;
  }
  if (attempt.codeModeStats) {
    const codeModeStats = target.codeModeStats ?? createCodeModeStats();
    mergeCodeModeStats(codeModeStats, attempt.codeModeStats);
    target.codeModeStats = codeModeStats;
  } else if (target.codeModeStats) {
    // Without an attempt sample the live gauge is unknown, not observed zero.
    // Keep cumulative lifecycle totals while dropping the stale prior sample.
    delete target.codeModeStats.bridgeLifecycle.unresolvedAtExtraction;
  }
};

export const toNormalizedUsage = (usage: UsageAccumulator): NormalizedUsage | undefined => {
  const hasUsage =
    usage.observedUsageBuckets.size > 0 ||
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.reasoningTokens > 0 ||
    usage.total > 0 ||
    usage.providerBilledCostReports > 0;
  if (!hasUsage) {
    return undefined;
  }
  const tokenCountsObserved = NORMALIZED_USAGE_BUCKET_ORDER.filter((bucket) =>
    usage.observedUsageBuckets.has(bucket),
  );
  return bindNormalizedUsageObservedBuckets(
    {
      input: usage.observedUsageBuckets.has("input") ? usage.input : usage.input || undefined,
      output: usage.observedUsageBuckets.has("output") ? usage.output : usage.output || undefined,
      cacheRead: usage.observedUsageBuckets.has("cacheRead")
        ? usage.cacheRead
        : usage.cacheRead || undefined,
      cacheWrite: usage.observedUsageBuckets.has("cacheWrite")
        ? usage.cacheWrite
        : usage.cacheWrite || undefined,
      ...(usage.observedUsageBuckets.has("reasoningTokens") || usage.reasoningTokens > 0
        ? { reasoningTokens: usage.reasoningTokens }
        : {}),
      total: usage.observedUsageBuckets.has("total") ? usage.total : usage.total || undefined,
      tokenCountsObserved,
      ...(usage.providerBilledCostReports > 0
        ? {
            providerBilledCost: {
              totalUsd: usage.providerBilledCostUsd,
              coverage:
                usage.providerBilledCostCompleteReports === usage.usageObservations
                  ? ("complete" as const)
                  : ("partial" as const),
            },
          }
        : {}),
    },
    tokenCountsObserved,
  );
};
