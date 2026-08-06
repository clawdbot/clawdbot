/**
 * Accumulates and normalizes per-call token usage across embedded runs.
 */
import type { NormalizedUsage } from "../usage.js";

export type UsageAccumulator = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningTokens: number;
  total: number;
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
  reasoningTokens: 0,
  total: 0,
  assistantTurns: 0,
});

type MaybeUsage = NormalizedUsage | undefined;

const hasUsageValues = (usage: MaybeUsage): usage is NormalizedUsage => {
  if (!usage) {
    return false;
  }
  return (
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
    usage.contextUsage?.state === "unavailable"
  );
};

export const mergeUsageIntoAccumulator = (target: UsageAccumulator, usage: MaybeUsage) => {
  if (!hasUsageValues(usage)) {
    return;
  }
  const callTotal =
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.reasoningTokens += usage.reasoningTokens ?? 0;
  target.total += callTotal;
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
  if (!hasUsage) {
    return undefined;
  }
  return {
    input: usage.input || undefined,
    output: usage.output || undefined,
    cacheRead: usage.cacheRead || undefined,
    cacheWrite: usage.cacheWrite || undefined,
    ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
    total: usage.total || undefined,
  };
};
