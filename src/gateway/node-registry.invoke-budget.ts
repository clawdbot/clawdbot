import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

/** Deadline budget a single node invoke spends from the moment it is admitted. */
type NodeInvokeBudget = {
  /** Timer-safe budget shared with the node; zero disables both deadlines. */
  readonly budgetMs: number;
  /**
   * Instant the caller's own deadline expires. Present only when the caller
   * supplied a positive timeout: callers that omit `timeoutMs` keep the shared
   * fallback as a post-dispatch pending timer, so their answer never changes
   * from a dispatched command to an undispatched TIMEOUT.
   */
  readonly dispatchDeadlineAtMs: number | undefined;
};

/**
 * Anchor the budget before the first await so pre-dispatch work spends it too.
 * A budget that only starts at dispatch can outlive the caller's own deadline,
 * and a send that lands after the caller already answered would contradict the
 * dispatch provenance that answer carried.
 */
export function startNodeInvokeBudget(timeoutMs: number | undefined): NodeInvokeBudget {
  const startedAtMs = Date.now();
  const suppliedBudgetMs = resolveTimerTimeoutMs(timeoutMs, 0, 0);
  return {
    budgetMs: resolveTimerTimeoutMs(timeoutMs, 30_000, 0),
    dispatchDeadlineAtMs: suppliedBudgetMs > 0 ? startedAtMs + suppliedBudgetMs : undefined,
  };
}

/**
 * Read the budget once every step that can spend it is behind us, so the node
 * timeout and the pending timer both start from what is actually left. Zero on
 * a caller-supplied deadline means dispatching now would hand the command to
 * the node after the caller's deadline already answered that none had been.
 */
export function resolveDispatchTimeoutMs(budget: NodeInvokeBudget): number {
  return budget.dispatchDeadlineAtMs === undefined
    ? budget.budgetMs
    : Math.max(0, budget.dispatchDeadlineAtMs - Date.now());
}
