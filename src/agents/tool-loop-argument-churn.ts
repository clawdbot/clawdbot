import type { ToolCallRecord } from "../logging/diagnostic-session-state.js";

const MIN_STABLE_CALLS_PER_VARIANT = 3;

export function getArgumentChurnNoProgressStreak(
  history: readonly ToolCallRecord[],
  toolName: string,
  currentArgsHash: string,
): { count: number; variantCount: number } {
  const outcomes = new Map<string, { resultHash: string; count: number }>();
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record || record.toolName !== toolName) {
      break;
    }
    if (!record.resultHash) {
      continue;
    }
    if (record.noProgress !== true) {
      break;
    }
    const previous = outcomes.get(record.argsHash);
    if (previous && previous.resultHash !== record.resultHash) {
      break;
    }
    outcomes.set(record.argsHash, {
      resultHash: record.resultHash,
      count: (previous?.count ?? 0) + 1,
    });
  }

  const allOutcomes = Array.from(outcomes.values());
  const count = allOutcomes.reduce((sum, outcome) => sum + outcome.count, 0);
  const stableOutcomes = allOutcomes.filter(
    (outcome) => outcome.count >= MIN_STABLE_CALLS_PER_VARIANT,
  );
  const hasSharedStableOutcome =
    new Set(stableOutcomes.map((outcome) => outcome.resultHash)).size === 1;
  const currentOutcome = outcomes.get(currentArgsHash);
  const hasOnlyStableVariants =
    stableOutcomes.reduce((sum, outcome) => sum + outcome.count, 0) === count;

  // This classifier is warning-only. Keep it narrow: every call in the tail must
  // belong to a repeated stable variant, and the proposed call must continue one
  // of those variants. A novel argument is a possible escape from the loop and
  // must reset liveness evidence rather than inherit it.
  const hasStableChurn =
    stableOutcomes.length > 1 &&
    hasOnlyStableVariants &&
    hasSharedStableOutcome &&
    (currentOutcome?.count ?? 0) >= MIN_STABLE_CALLS_PER_VARIANT;
  return hasStableChurn
    ? { count, variantCount: stableOutcomes.length }
    : { count: 0, variantCount: 0 };
}

export function buildArgumentChurnWarning(
  toolName: string,
  churn: { count: number; variantCount: number },
) {
  return {
    stuck: true as const,
    level: "warning" as const,
    detector: "argument_churn" as const,
    count: churn.count,
    message: `WARNING: ${toolName} has cycled through ${churn.variantCount} repeated argument patterns with the same stable outcome ${churn.count} times. Continued churn is treated as stalled run activity, but this tool call remains allowed.`,
    warningKey: `argument-churn:${toolName}`,
    livenessSignal: "argument_churn" as const,
  };
}
