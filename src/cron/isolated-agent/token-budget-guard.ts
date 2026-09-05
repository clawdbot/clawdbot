import type { NormalizedUsage } from "../../agents/usage.js";

export type TokenBudgetGuard = (usage: NormalizedUsage) => void;

/**
 * Thrown when a cron run's observed token spend reaches its `tokenBudget`.
 * Carries the producer-recorded usage total so the run boundary can surface
 * `usage` and `completionCause: "budget-exhausted"` on the terminal result
 * instead of reconstructing them downstream from an opaque error message.
 */
export class CronTokenBudgetExhaustedError extends Error {
  readonly budget: number;
  readonly usageTotal: number;
  constructor(params: { budget: number; usageTotal: number; cause?: unknown }) {
    super(
      `Token budget exhausted: the run reached its ${params.budget}-token cap`,
      params.cause !== undefined ? { cause: params.cause } : undefined,
    );
    this.name = "CronTokenBudgetExhaustedError";
    this.budget = params.budget;
    this.usageTotal = params.usageTotal;
  }
}

/** True when `error` is a typed cron token-budget trip. */
export function isCronTokenBudgetExhaustedError(
  error: unknown,
): error is CronTokenBudgetExhaustedError {
  return error instanceof CronTokenBudgetExhaustedError;
}

/**
 * Arms a one-shot token-budget tripwire over run-cumulative usage snapshots.
 * The guard fires `onExceeded` once, at the first snapshot whose cumulative
 * total reaches the budget; usage snapshots without a total never trip it.
 * A guard armed with an already-aborted signal stays inert.
 */
export function createTokenBudgetGuard(params: {
  budget: number;
  onExceeded: (usage: NormalizedUsage) => void;
  signal?: AbortSignal;
}): TokenBudgetGuard {
  let tripped = false;
  return (usage) => {
    if (tripped || params.signal?.aborted) {
      return;
    }
    if (typeof usage.total !== "number") {
      return;
    }
    if (usage.total >= params.budget) {
      tripped = true;
      params.onExceeded(usage);
    }
  };
}
