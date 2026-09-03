import crypto from "node:crypto";
import { resolveFreshSessionTotalTokens } from "./types.js";
import type { SessionEntry, SessionGoal, SessionGoalStatus } from "./types.js";

export class SessionGoalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionGoalTransitionError";
  }
}

const TERMINAL_GOAL_STATUSES = new Set<SessionGoalStatus>(["complete"]);

function normalizeTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function resolveEntryFreshTotalTokens(
  entry: Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "totalTokensVersion">,
): number | undefined {
  return normalizeTokenCount(resolveFreshSessionTotalTokens(entry));
}

function resolveEntryGoalStartTokens(
  entry: Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "totalTokensVersion">,
): number {
  return resolveEntryFreshTotalTokens(entry) ?? 0;
}

function normalizeTokenBudget(value: number | undefined): number | undefined {
  const normalized = normalizeTokenCount(value);
  return normalized && normalized > 0 ? normalized : undefined;
}

export function accountSessionGoalUsage(
  entry: Pick<SessionEntry, "goal" | "totalTokens" | "totalTokensFresh" | "totalTokensVersion">,
  now: number,
  options?: { adoptFreshBaseline?: boolean },
): SessionGoal | undefined {
  // `goal` is introduced here as a core-owned slot; no shipped plugin-owned
  // goal state exists to migrate, and plugin slot registration now reserves it.
  const goal = entry.goal;
  if (!goal) {
    return undefined;
  }
  const totalTokens = resolveEntryFreshTotalTokens(entry);
  const hasFreshStart = goal.tokenStartFresh !== false;
  // Old entries may have a stale token baseline; display-only reads can hold it, while persisted
  // reads adopt the fresh total so future budget checks use current accounting.
  const shouldHoldStaleStart = !hasFreshStart && options?.adoptFreshBaseline === false;
  const shouldAdoptFreshStart =
    !shouldHoldStaleStart && totalTokens !== undefined && !hasFreshStart;
  const tokenStart = shouldAdoptFreshStart
    ? totalTokens
    : (normalizeTokenCount(goal.tokenStart) ?? totalTokens ?? 0);
  const tokensUsed =
    totalTokens === undefined || shouldAdoptFreshStart || shouldHoldStaleStart
      ? goal.tokensUsed
      : Math.max(goal.tokensUsed, Math.max(0, totalTokens - tokenStart));
  const next: SessionGoal = {
    ...goal,
    tokenStart,
    tokenStartFresh: hasFreshStart || shouldAdoptFreshStart,
    tokensUsed,
  };
  if (
    next.status === "active" &&
    next.tokenBudget !== undefined &&
    tokensUsed >= next.tokenBudget
  ) {
    next.status = "budget_limited";
    next.budgetLimitedAt = now;
    next.updatedAt = now;
  }
  return next;
}

export function buildCreatedSessionGoal(
  entry: SessionEntry,
  options: { objective: string; tokenBudget?: number },
  now: number,
): SessionGoal {
  const objective = options.objective;
  if (!objective.trim()) {
    throw new SessionGoalTransitionError("objective required");
  }
  if (entry.goal) {
    throw new SessionGoalTransitionError("goal already exists");
  }
  const tokenBudget = normalizeTokenBudget(options.tokenBudget);
  const tokenStartFresh = resolveEntryFreshTotalTokens(entry) !== undefined;
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    objective,
    status: "active",
    createdAt: now,
    updatedAt: now,
    tokenStart: resolveEntryGoalStartTokens(entry),
    tokenStartFresh,
    tokensUsed: 0,
    ...(tokenBudget ? { tokenBudget } : {}),
    continuationTurns: 0,
  };
}

export function buildUpdatedSessionGoalStatus(
  entry: SessionEntry,
  options: {
    status: Extract<SessionGoalStatus, "active" | "paused" | "blocked" | "complete">;
    note?: string;
  },
  now: number,
): SessionGoal {
  const accounted = accountSessionGoalUsage(entry, now);
  if (!accounted) {
    throw new SessionGoalTransitionError("goal not found");
  }
  if (TERMINAL_GOAL_STATUSES.has(accounted.status) && accounted.status !== options.status) {
    throw new SessionGoalTransitionError(`goal is already ${accounted.status}`);
  }
  const resetsBudgetWindow =
    options.status === "active" &&
    (accounted.status === "budget_limited" ||
      accounted.status === "usage_limited" ||
      (accounted.tokenBudget !== undefined && accounted.tokensUsed >= accounted.tokenBudget));
  // Resuming from a limited state starts a new budget window at the current fresh token count.
  const freshTokenStart = resetsBudgetWindow ? resolveEntryFreshTotalTokens(entry) : undefined;
  const next: SessionGoal = {
    ...accounted,
    status: options.status,
    updatedAt: now,
    ...(options.note ? { lastStatusNote: options.note } : {}),
    ...(options.status === "paused" ? { pausedAt: now } : {}),
    ...(options.status === "blocked" ? { blockedAt: now } : {}),
    ...(options.status === "complete" ? { completedAt: now } : {}),
  };
  if (resetsBudgetWindow) {
    next.tokenStart = freshTokenStart ?? 0;
    next.tokenStartFresh = freshTokenStart !== undefined;
    next.tokensUsed = 0;
    delete next.budgetLimitedAt;
    delete next.usageLimitedAt;
  }
  if (
    next.status === "active" &&
    next.tokenBudget !== undefined &&
    next.tokensUsed >= next.tokenBudget
  ) {
    next.status = "budget_limited";
    next.budgetLimitedAt = now;
  }
  return next;
}

export function buildUpdatedSessionGoalObjective(
  entry: SessionEntry,
  objective: string,
  now: number,
): SessionGoal {
  if (!objective.trim()) {
    throw new SessionGoalTransitionError("objective required");
  }
  const accounted = accountSessionGoalUsage(entry, now);
  if (!accounted) {
    throw new SessionGoalTransitionError("goal not found");
  }
  if (TERMINAL_GOAL_STATUSES.has(accounted.status)) {
    throw new SessionGoalTransitionError(`goal is already ${accounted.status}`);
  }
  // Rewording keeps status and token accounting; only the target moves.
  return { ...accounted, objective, updatedAt: now };
}
