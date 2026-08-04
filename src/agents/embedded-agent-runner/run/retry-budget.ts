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
