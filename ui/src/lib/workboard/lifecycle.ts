import type { GatewaySessionRow } from "../../api/types.ts";
import { isFailedSessionStatus, staleSessionState, workboardCardSessionKey } from "./card-state.ts";
import { sessionUpdatedAtValue, taskLifecycleSourceUpdatedAt } from "./task-links.ts";
import type { WorkboardCard, WorkboardLifecycle, WorkboardTaskSummary } from "./types.ts";

export function findWorkboardSession(
  card: WorkboardCard,
  sessions: readonly GatewaySessionRow[],
): GatewaySessionRow | null {
  const sessionKey = workboardCardSessionKey(card);
  if (!sessionKey) {
    return null;
  }
  return sessions.find((session) => session.key === sessionKey) ?? null;
}

export function getWorkboardLifecycle(
  card: WorkboardCard,
  sessions: readonly GatewaySessionRow[],
  task?: WorkboardTaskSummary,
): WorkboardLifecycle {
  const session = findWorkboardSession(card, sessions);
  if (task) {
    switch (task.status) {
      case "queued":
      case "running":
        if (
          session &&
          (session.abortedLastRun ||
            session.status === "done" ||
            isFailedSessionStatus(session.status))
        ) {
          break;
        }
        return {
          session,
          state: "running",
          targetStatus: "running",
          sourceUpdatedAt: taskLifecycleSourceUpdatedAt(task),
        };
      case "completed":
        return {
          session,
          state: "succeeded",
          targetStatus: "review",
          sourceUpdatedAt: taskLifecycleSourceUpdatedAt(task),
        };
      case "failed":
      case "cancelled":
      case "timed_out":
        return {
          session,
          state: "failed",
          targetStatus: "blocked",
          sourceUpdatedAt: taskLifecycleSourceUpdatedAt(task),
        };
    }
  }
  if (!workboardCardSessionKey(card)) {
    return { session: null, state: "unlinked" };
  }
  if (!session) {
    return { session: null, state: "missing" };
  }
  if (staleSessionState(session)) {
    return {
      session,
      state: "stale",
      targetStatus: "running",
      sourceUpdatedAt: sessionUpdatedAtValue(session),
    };
  }
  if (session.hasActiveRun === true || session.status === "running") {
    return {
      session,
      state: "running",
      targetStatus: "running",
      sourceUpdatedAt: sessionUpdatedAtValue(session),
    };
  }
  if (session.abortedLastRun || isFailedSessionStatus(session.status)) {
    return {
      session,
      state: "failed",
      targetStatus: "blocked",
      sourceUpdatedAt: sessionUpdatedAtValue(session),
    };
  }
  if (session.status === "done") {
    return {
      session,
      state: "succeeded",
      targetStatus: "review",
      sourceUpdatedAt: sessionUpdatedAtValue(session),
    };
  }
  return { session, state: "idle" };
}
