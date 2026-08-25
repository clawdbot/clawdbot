import type { ToolCallRecord } from "../logging/diagnostic-session-state.js";

const MIN_STABLE_CALLS_PER_VARIANT = 3;

function getArgumentChurnNoProgressStreak(
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

function getWriteMutationChurnStreak(
  history: readonly ToolCallRecord[],
  current: Pick<ToolCallRecord, "argsHash" | "mutationTargetHash" | "outcomeKind" | "resultHash">,
): { count: number; variantCount: number } {
  if (
    !current.mutationTargetHash ||
    ((current.resultHash !== undefined || current.outcomeKind !== undefined) &&
      current.outcomeKind !== "write-mutation")
  ) {
    return { count: 0, variantCount: 0 };
  }
  const variants = new Set<string>();
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (
      !record ||
      record.toolName !== "write" ||
      record.outcomeKind !== "write-mutation" ||
      record.mutationTargetHash !== current.mutationTargetHash
    ) {
      break;
    }
    variants.add(record.argsHash);
  }
  if (variants.has(current.argsHash)) {
    return { count: 0, variantCount: 0 };
  }
  return { count: variants.size, variantCount: variants.size };
}

export function getToolArgumentChurnStreak(
  history: readonly ToolCallRecord[],
  current: ToolCallRecord,
): {
  count: number;
  variantCount: number;
  kind?: "write_mutation";
  mutationTargetHash?: string;
} {
  if (current.outcomeKind === "write-mutation") {
    const writeMutation = getWriteMutationChurnStreak(history, current);
    return writeMutation.count > 0
      ? { ...writeMutation, kind: "write_mutation", mutationTargetHash: current.mutationTargetHash }
      : writeMutation;
  }
  if (current.resultHash !== undefined && current.noProgress !== true) {
    return { count: 0, variantCount: 0 };
  }
  const noProgress = getArgumentChurnNoProgressStreak(history, current.toolName, current.argsHash);
  if (noProgress.count > 0) {
    return noProgress;
  }
  const writeMutation = getWriteMutationChurnStreak(history, current);
  return writeMutation.count > 0
    ? { ...writeMutation, kind: "write_mutation", mutationTargetHash: current.mutationTargetHash }
    : writeMutation;
}

export function buildArgumentChurnWarning(
  toolName: string,
  churn: {
    count: number;
    variantCount: number;
    kind?: "write_mutation";
    mutationTargetHash?: string;
  },
) {
  if (churn.kind === "write_mutation") {
    return {
      stuck: true as const,
      level: "warning" as const,
      detector: "argument_churn" as const,
      count: churn.count,
      message: `WARNING: ${toolName} has changed the same target with ${churn.variantCount} distinct argument variants and no intervening verification. Continued rewriting is treated as stalled run activity, but this tool call remains allowed. Read or verify the current result before rewriting it again.`,
      warningKey: `argument-churn:${toolName}:write-mutation:${churn.mutationTargetHash ?? "unknown"}`,
      livenessSignal: "argument_churn" as const,
    };
  }
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
