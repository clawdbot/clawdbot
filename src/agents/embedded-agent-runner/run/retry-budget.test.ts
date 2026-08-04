import { describe, expect, it } from "vitest";
import {
  beginRunAttempt,
  createRunRetryBudget,
  isRunRetryBudgetExhausted,
} from "./retry-budget.js";

describe("run retry budget", () => {
  it("counts every dispatched attempt toward the recovery limit", () => {
    const budget = createRunRetryBudget(32);

    for (let step = 0; step < 32; step += 1) {
      beginRunAttempt(budget);
    }

    expect(budget).toEqual({ attemptsDispatched: 32, attemptsCounted: 32, maxAttempts: 32 });
    expect(isRunRetryBudgetExhausted(budget)).toBe(true);
  });
});
