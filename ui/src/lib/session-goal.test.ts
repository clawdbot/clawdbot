// Control UI tests cover session goal behavior.
import { describe, expect, it } from "vitest";
import type { SessionGoal } from "../api/types.ts";
import {
  formatGoalDetail,
  formatGoalElapsed,
  formatGoalSummary,
  goalElapsedMs,
} from "./session-goal.ts";

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

  it("tracks elapsed time live for active goals and freezes it on status stops", () => {
    const active = buildGoal({ createdAt: 1_000 });
    expect(goalElapsedMs(active, 16_000)).toBe(15_000);

    const paused = buildGoal({ status: "paused", createdAt: 1_000, pausedAt: 61_000 });
    expect(goalElapsedMs(paused, 999_000)).toBe(60_000);

    const complete = buildGoal({ status: "complete", createdAt: 1_000, completedAt: 121_000 });
    expect(goalElapsedMs(complete, 999_000)).toBe(120_000);

    const blockedWithoutTimestamp = buildGoal({
      status: "blocked",
      createdAt: 1_000,
      updatedAt: 31_000,
    });
    expect(goalElapsedMs(blockedWithoutTimestamp, 999_000)).toBe(30_000);
  });

  it("formats elapsed durations compactly", () => {
    expect(formatGoalElapsed(0)).toBe("0s");
    expect(formatGoalElapsed(15_000)).toBe("15s");
    expect(formatGoalElapsed(59_999)).toBe("59s");
    expect(formatGoalElapsed(60_000)).toBe("1m");
    expect(formatGoalElapsed(3_540_000)).toBe("59m");
    expect(formatGoalElapsed(3_600_000)).toBe("1h");
    expect(formatGoalElapsed(3_900_000)).toBe("1h 5m");
  });
});
