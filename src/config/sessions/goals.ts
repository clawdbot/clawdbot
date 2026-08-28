// Session goal state tracks objective progress and token budgets in the session store.
import {
  recordSessionGoalChanged,
  type SessionStateActorType,
} from "../../sessions/session-state-events.js";
import { formatTokenCount } from "../../utils/token-format.js";
import {
  accountSessionGoalUsage,
  buildCreatedSessionGoal,
  buildUpdatedSessionGoalObjective,
  buildUpdatedSessionGoalStatus,
} from "./goals-transitions.js";
import { loadSessionEntryReadOnly, patchSessionEntryCore } from "./session-accessor.js";
import type { SessionEntry, SessionGoal, SessionGoalStatus } from "./types.js";

type SessionGoalSnapshot = {
  status: "missing" | "found";
  goal?: SessionGoal;
};

type SessionGoalStoreOptions = {
  sessionKey: string;
  storePath?: string;
  now?: number;
  fallbackEntry?: SessionEntry;
  persist?: boolean;
  actor?: { type: SessionStateActorType; id?: string };
  agentId?: string;
};

type CreateSessionGoalOptions = SessionGoalStoreOptions & {
  objective: string;
  tokenBudget?: number;
};

type UpdateSessionGoalStatusOptions = SessionGoalStoreOptions & {
  status: Extract<SessionGoalStatus, "active" | "paused" | "blocked" | "complete">;
  note?: string;
};

export const MODEL_UPDATABLE_SESSION_GOAL_STATUSES = [
  "complete",
  "blocked",
  "paused",
  "active",
] as const;

function nowMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function cloneGoal(goal: SessionGoal): SessionGoal {
  return { ...goal };
}

function recordGoalChange(
  options: SessionGoalStoreOptions,
  entry: SessionEntry,
  summary: string,
): void {
  recordSessionGoalChanged({
    sessionKey: options.sessionKey,
    entry,
    actor: options.actor,
    agentId: options.agentId,
    summary,
  });
}

export function resolveSessionGoalDisplayState(
  entry: Pick<SessionEntry, "goal" | "totalTokens" | "totalTokensFresh" | "totalTokensVersion">,
  now?: number,
  options?: { adoptFreshBaseline?: boolean },
): SessionGoal | undefined {
  return accountSessionGoalUsage(entry, nowMs(now), options);
}

function goalsEqual(a: SessionGoal | undefined, b: SessionGoal | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function formatSessionGoalStatus(goal: SessionGoal | undefined): string {
  if (!goal) {
    return "No goal for this session.\nStart one with /goal start <objective>.";
  }
  const budget =
    goal.tokenBudget === undefined
      ? ""
      : `\nToken budget: ${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`;
  const note = goal.lastStatusNote ? `\nNote: ${goal.lastStatusNote}` : "";
  const commands = resolveGoalCommandHint(goal.status);
  return [
    "Goal",
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Tokens used: ${formatTokenCount(goal.tokensUsed)}`,
    ...(budget ? [budget.slice(1)] : []),
    ...(note ? [note.slice(1)] : []),
    "",
    `Commands: ${commands}`,
  ].join("\n");
}

function resolveGoalCommandHint(status: SessionGoalStatus): string {
  switch (status) {
    case "active":
      return "/goal edit <objective>, /goal pause, /goal complete, /goal clear";
    case "paused":
    case "blocked":
    case "usage_limited":
    case "budget_limited":
      return "/goal resume, /goal edit <objective>, /goal clear";
    case "complete":
      return "/goal clear";
  }
  return "/goal";
}

export async function getSessionGoal(
  options: SessionGoalStoreOptions,
): Promise<SessionGoalSnapshot> {
  const now = nowMs(options.now);
  if (options.persist === false) {
    // Status rendering should not write incidental budget/baseline adoption unless callers opt in.
    const entry =
      loadSessionEntryReadOnly({ sessionKey: options.sessionKey, storePath: options.storePath }) ??
      options.fallbackEntry;
    const projected = entry
      ? resolveSessionGoalDisplayState(entry, now, { adoptFreshBaseline: false })
      : undefined;
    return projected ? { status: "found", goal: projected } : { status: "missing" };
  }
  let goal: SessionGoal | undefined;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const accounted = accountSessionGoalUsage(entry, now);
      goal = accounted ? cloneGoal(accounted) : undefined;
      if (!accounted || goalsEqual(accounted, entry.goal)) {
        return null;
      }
      return { goal: accounted };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  if (!result || !goal) {
    return { status: "missing" };
  }
  return { status: "found", goal };
}

export async function createSessionGoal(options: CreateSessionGoalOptions): Promise<SessionGoal> {
  const objective = options.objective.trim();
  if (!objective) {
    throw new Error("objective required");
  }
  const now = nowMs(options.now);
  let created: SessionGoal | undefined;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      created = buildCreatedSessionGoal(
        entry,
        { objective, tokenBudget: options.tokenBudget },
        now,
      );
      return { goal: created };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  if (!result || !created) {
    throw new Error("session not found");
  }
  recordGoalChange(options, result, "goal created");
  return cloneGoal(created);
}

export async function updateSessionGoalStatus(
  options: UpdateSessionGoalStatusOptions,
): Promise<SessionGoal> {
  const now = nowMs(options.now);
  let updated: SessionGoal | undefined;
  let foundSession = false;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      foundSession = true;
      updated = buildUpdatedSessionGoalStatus(entry, options, now);
      return { goal: updated };
    },
    },
  );
  if (!result || !updated) {
    throw new Error(foundSession ? "goal not found" : "session not found");
  }
  recordGoalChange(options, result, `goal status changed to ${updated.status}`);
  return cloneGoal(updated);
}

export async function updateSessionGoalObjective(
  options: SessionGoalStoreOptions & { objective: string },
): Promise<SessionGoal> {
  const objective = options.objective.trim();
  if (!objective) {
    throw new Error("objective required");
  }
  const now = nowMs(options.now);
  let updated: SessionGoal | undefined;
  let foundSession = false;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      foundSession = true;
      updated = buildUpdatedSessionGoalObjective(entry, objective, now);
      return { goal: updated };
    },
  );
  if (!result || !updated) {
    throw new Error(foundSession ? "goal not found" : "session not found");
  }
  recordGoalChange(options, result, "goal objective changed");
  return cloneGoal(updated);
}

export async function clearSessionGoal(options: SessionGoalStoreOptions): Promise<boolean> {
  let removed = false;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      if (!entry.goal) {
        return null;
      }
      removed = true;
      return { goal: undefined };
    },
  );
  if (result && removed) {
    recordGoalChange(options, result, "goal cleared");
  }
  return Boolean(result && removed);
}
