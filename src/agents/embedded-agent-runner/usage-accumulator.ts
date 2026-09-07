/**
 * Accumulates per-call token usage and monetary totals across embedded runs.
 */
import { hasBillableUsage } from "../usage.js";
import type { NormalizedUsage } from "../usage.js";

export type UsageAccumulator = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheReadReported?: true;
  cacheWriteReported?: true;
  cacheWrite1h: number;
  reasoningTokens: number;
  total: number;
  /** Undefined means unobserved; any missing call price makes the complete sum unavailable. */
  cost: { total: number } | "unavailable" | undefined;
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
};

export const createUsageAccumulator = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  reasoningTokens: 0,
  total: 0,
  cost: undefined,
  assistantTurns: 0,
});

export const mergeUsageIntoAccumulator = (
  target: UsageAccumulator,
  usage: NormalizedUsage | undefined,
) => {
  if (!hasBillableUsage(usage)) {
    return;
  }
  const callTotal =
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  if (usage.cacheRead !== undefined) {
    target.cacheReadReported = true;
  }
  if (usage.cacheWrite !== undefined) {
    target.cacheWriteReported = true;
  }
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.cacheWrite1h += usage.cacheWrite1h ?? 0;
  target.reasoningTokens += usage.reasoningTokens ?? 0;
  target.total += callTotal;
  target.cost =
    target.cost !== "unavailable" && usage.cost
      ? { total: (target.cost?.total ?? 0) + usage.cost.total }
      : "unavailable";
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
  },
) => {
  target.assistantTurns += attempt.assistantTurns ?? 0;
  if (!attempt.bridgeCalls) {
    return;
  }
  const bridgeCalls = target.bridgeCalls ?? { search: 0, describe: 0, call: 0 };
  bridgeCalls.search += attempt.bridgeCalls.search;
  bridgeCalls.describe += attempt.bridgeCalls.describe;
  bridgeCalls.call += attempt.bridgeCalls.call;
  target.bridgeCalls = bridgeCalls;
};

export const toNormalizedUsage = (usage: UsageAccumulator): NormalizedUsage | undefined => {
  const hasUsage =
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.reasoningTokens > 0 ||
    usage.total > 0;
  const cost = usage.cost === "unavailable" ? undefined : usage.cost;
  if (!hasUsage && !cost) {
    return undefined;
  }
  const derivedTotal = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return {
    input: usage.input || undefined,
    output: usage.output || undefined,
    cacheRead: usage.cacheReadReported ? usage.cacheRead : usage.cacheRead || undefined,
    cacheWrite: usage.cacheWriteReported ? usage.cacheWrite : usage.cacheWrite || undefined,
    ...(usage.cacheWrite1h > 0 ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
    total: usage.total || derivedTotal || undefined,
    ...(cost ? { cost: { ...cost } } : {}),
  };
};
