export type RunRetryKind = "progress_continuation" | "recovery";

type RunRetryBudget = {
  attemptsDispatched: number;
  attemptsCounted: number;
  maxAttempts: number;
};

export function createRunRetryBudget(maxAttempts: number): RunRetryBudget {
  return { attemptsDispatched: 0, attemptsCounted: 0, maxAttempts };
}

export function isRunRetryBudgetExhausted(budget: RunRetryBudget): boolean {
  return budget.attemptsCounted >= budget.maxAttempts;
}

export function beginRunAttempt(budget: RunRetryBudget): void {
  budget.attemptsDispatched += 1;
  budget.attemptsCounted += 1;
}

export function resolveRunRetryKind(params: {
  preflightRecovery: { route: string; truncatedCount?: number };
  retryingFromTranscript: boolean;
  toolMetas: Array<{ isError?: boolean; meta?: string; toolName: string }>;
}): RunRetryKind {
  return params.retryingFromTranscript &&
    params.preflightRecovery.route === "truncate_tool_results_only" &&
    params.preflightRecovery.truncatedCount === 0 &&
    params.toolMetas.some((tool) => tool.isError !== true)
    ? "progress_continuation"
    : "recovery";
}

export function recordRunRetry(budget: RunRetryBudget, kind: RunRetryKind): void {
  if (kind === "progress_continuation") {
    budget.attemptsCounted = Math.max(0, budget.attemptsCounted - 1);
  }
}
