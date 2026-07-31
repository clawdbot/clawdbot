/**
 * Accumulates and normalizes per-call token usage across embedded runs.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NormalizedUsage } from "../usage.js";
import type { ToolSummaryTrace } from "./types.js";

export type UsageAccumulator = {
  input: number;
  output: number;
  cacheRead: number;
  cacheReadReported: boolean;
  cacheWrite: number;
  cacheWriteReported: boolean;
  reasoningTokens: number;
  total: number;
  /**
   * Completed assistant round trips across every model attempt of the run.
   * Kept beside token totals so retried attempts stay counted like their usage.
   */
  assistantTurns: number;
  /** True once any attempt in the run engaged the Code Mode control surface. */
  codeModeEngaged?: boolean;
  /**
   * Cumulative inner bridge calls across attempts. Present only once an
   * attempt reported a tool-search/code-mode catalog, so catalog-less runs
   * omit the field instead of publishing zero sentinels.
   */
  bridgeCalls?: {
    search: number;
    describe: number;
    call: number;
    sequence?: string[];
    failures?: number;
  };
  /** Cumulative outer tool calls across continuation and fallback attempts. */
  toolSummary?: ToolSummaryTrace;
};

export const createUsageAccumulator = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheReadReported: false,
  cacheWrite: 0,
  cacheWriteReported: false,
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
  target.cacheReadReported ||= typeof usage.cacheRead === "number";
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWriteReported ||= typeof usage.cacheWrite === "number";
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
    bridgeCalls?: {
      search: number;
      describe: number;
      call: number;
      sequence?: string[];
      failures?: number;
    };
    codeModeEngaged?: boolean;
    toolMetas?: Array<{ toolName: string; durationMs?: number; isError?: boolean }>;
    lastToolError?: unknown;
  },
) => {
  target.assistantTurns += attempt.assistantTurns ?? 0;
  if (attempt.codeModeEngaged === true) {
    target.codeModeEngaged = true;
  }
  const toolMetas = attempt.toolMetas ?? [];
  const fallbackHadFailure = attempt.lastToolError !== undefined;
  if (toolMetas.length > 0 || fallbackHadFailure) {
    const previous = target.toolSummary;
    const tools = previous ? [...previous.tools] : [];
    const sequence = previous?.sequence ? [...previous.sequence] : [];
    const seen = new Set(tools);
    for (const entry of toolMetas) {
      const toolName = normalizeOptionalString(entry.toolName);
      if (toolName) {
        sequence.push(toolName);
        if (!seen.has(toolName)) {
          seen.add(toolName);
          tools.push(toolName);
        }
      }
    }
    const fallbackToolName = normalizeOptionalString(
      (attempt.lastToolError as { toolName?: unknown } | undefined)?.toolName,
    );
    if (fallbackToolName && !seen.has(fallbackToolName)) {
      tools.push(fallbackToolName);
    }
    if (fallbackToolName && toolMetas.length === 0) {
      sequence.push(fallbackToolName);
    }
    const failedCalls = toolMetas.filter((entry) => entry.isError === true).length;
    const metadataMissingForFailure = fallbackHadFailure && toolMetas.length === 0;
    const attemptToolTimeMs = toolMetas.reduce((total, entry) => {
      const durationMs = entry.durationMs;
      return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
        ? total + durationMs
        : total;
    }, 0);
    target.toolSummary = {
      calls: (previous?.calls ?? 0) + toolMetas.length + Number(metadataMissingForFailure),
      tools,
      sequence,
      failures: (previous?.failures ?? 0) + (failedCalls || Number(fallbackHadFailure)),
      ...((previous?.totalToolTimeMs ?? 0) + attemptToolTimeMs > 0
        ? { totalToolTimeMs: (previous?.totalToolTimeMs ?? 0) + attemptToolTimeMs }
        : {}),
    };
  }
  if (!attempt.bridgeCalls) {
    return;
  }
  const bridgeCalls = target.bridgeCalls ?? { search: 0, describe: 0, call: 0 };
  bridgeCalls.search += attempt.bridgeCalls.search;
  bridgeCalls.describe += attempt.bridgeCalls.describe;
  bridgeCalls.call += attempt.bridgeCalls.call;
  bridgeCalls.failures = (bridgeCalls.failures ?? 0) + (attempt.bridgeCalls.failures ?? 0);
  if (attempt.bridgeCalls.sequence) {
    bridgeCalls.sequence = [...(bridgeCalls.sequence ?? []), ...attempt.bridgeCalls.sequence];
  }
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
    cacheRead: usage.cacheReadReported ? usage.cacheRead : undefined,
    cacheWrite: usage.cacheWriteReported ? usage.cacheWrite : undefined,
    ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
    total: usage.total || undefined,
  };
};
