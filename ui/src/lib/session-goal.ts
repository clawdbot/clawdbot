// Control UI module implements session goal behavior.
import type { SessionGoal } from "../api/types.ts";

function formatGoalTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value < 1000) {
    return String(Math.round(value));
  }
  if (value < 1_000_000) {
    const rounded = value >= 10_000 ? Math.round(value / 1000) : Math.round(value / 100) / 10;
    if (rounded >= 1000) {
      return "1m";
    }
    return `${rounded}k`;
  }
  const rounded =
    value >= 10_000_000 ? Math.round(value / 1_000_000) : Math.round(value / 100_000) / 10;
  return `${rounded}m`;
}

export function formatGoalUsage(goal: SessionGoal): string | null {
  if (typeof goal.tokenBudget === "number" && Number.isFinite(goal.tokenBudget)) {
    return `${formatGoalTokenCount(goal.tokensUsed)}/${formatGoalTokenCount(goal.tokenBudget)}`;
  }
  if (goal.tokensUsed > 0) {
    return `${formatGoalTokenCount(goal.tokensUsed)} used`;
  }
  return null;
}

export function formatGoalStatusLabel(status: SessionGoal["status"]): string {
  switch (status) {
    case "active":
      return "Pursuing goal";
    case "paused":
      return "Goal paused";
    case "blocked":
      return "Goal blocked";
    case "usage_limited":
      return "Goal hit usage limits";
    case "budget_limited":
      return "Goal unmet";
    case "complete":
      return "Goal achieved";
  }
  const unreachable: never = status;
  return unreachable;
}

export function formatGoalSummary(goal: SessionGoal): string {
  const usage = formatGoalUsage(goal);
  const status = formatGoalStatusLabel(goal.status);
  return usage ? `${status} (${usage})` : status;
}

/** Wall-clock time spent on the goal; frozen at the status timestamp once not active. */
export function goalElapsedMs(goal: SessionGoal, now: number): number {
  const stoppedAt = (() => {
    switch (goal.status) {
      case "active":
        return now;
      case "paused":
        return goal.pausedAt ?? goal.updatedAt;
      case "blocked":
        return goal.blockedAt ?? goal.updatedAt;
      case "usage_limited":
        return goal.usageLimitedAt ?? goal.updatedAt;
      case "budget_limited":
        return goal.budgetLimitedAt ?? goal.updatedAt;
      case "complete":
        return goal.completedAt ?? goal.updatedAt;
    }
    const unreachable: never = goal.status;
    return unreachable;
  })();
  return Math.max(0, stoppedAt - goal.createdAt);
}

export function formatGoalElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function formatGoalDetail(goal: SessionGoal): string {
  const note = goal.lastStatusNote ? ` - ${goal.lastStatusNote}` : "";
  return `${formatGoalSummary(goal)}: ${goal.objective}${note}`;
}
