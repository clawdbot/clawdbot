// Control UI tests cover session goal behavior.
import { describe, expect, it } from "vitest";
import { formatGoalDetail, formatGoalSummary, formatGoalTokenCount } from "./session-goal.ts";
import type { SessionGoal } from "./types.ts";

function buildGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    schemaVersion: 1,
    id: "goal-1",
    objective: "Ship the web goal indicator",
    status: "active",
    createdAt: 1,
    updatedAt: 2,
    tokenStart: 100,
    tokensUsed: 12_400,
    tokenBudget: 50_000,
    continuationTurns: 0,
    ...overrides,
  };
}

describe("session goal formatting", () => {
  it("formats compact token counts for goal usage", () => {
    expect(formatGoalTokenCount(999)).toBe("999");
    expect(formatGoalTokenCount(1_240)).toBe("1.2k");
    expect(formatGoalTokenCount(12_400)).toBe("12k");
    expect(formatGoalTokenCount(999_999)).toBe("1m");
    expect(formatGoalTokenCount(1_240_000)).toBe("1.2m");
  });

  it("summarizes goal status and objective details", () => {
    const goal = buildGoal({ lastStatusNote: "Waiting for CI" });

    expect(formatGoalSummary(goal)).toBe("Pursuing goal (12k/50k)");
    expect(formatGoalDetail(goal)).toBe(
      "Pursuing goal (12k/50k): Ship the web goal indicator - Waiting for CI",
    );
  });

  it("uses terminal labels without a budget", () => {
    expect(formatGoalSummary(buildGoal({ status: "complete", tokenBudget: undefined }))).toBe(
      "Goal achieved (12k used)",
    );
  });
});
