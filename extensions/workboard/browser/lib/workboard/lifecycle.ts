import type { GatewaySessionRow } from "../../api/types.ts";
import { normalizeSessionKeyForUiComparison } from "../sessions/session-key.ts";
import { isFailedSessionStatus, staleSessionState, workboardCardSessionKey } from "./card-state.ts";
import { isReservedSessionKey } from "./session-links.ts";
import type { WorkboardSessionResolution } from "./session-resolution.ts";
import { sessionUpdatedAtValue, taskLifecycleSourceUpdatedAt } from "./task-links.ts";
import type { WorkboardCard, WorkboardLifecycle, WorkboardTaskSummary } from "./types.ts";

export function findWorkboardSession(
  card: WorkboardCard,
  sessions: readonly GatewaySessionRow[],
  resolution?: WorkboardSessionResolution,
): GatewaySessionRow | null {
  const sessionKey = workboardCardSessionKey(card);
  if (!sessionKey || isReservedSessionKey(sessionKey)) {
    return null;
  }
  const key = normalizeSessionKeyForUiComparison(sessionKey);
  if (resolution?.key === key) {
    return resolution.status === "resolved" ? resolution.session : null;
  }
  // A filtered roster proves exact positive matches, never provisional uniqueness.
  return (
    sessions.find((session) => normalizeSessionKeyForUiComparison(session.key) === key) ?? null
  );
}

export function getWorkboardLifecycle(
  card: WorkboardCard,
  sessions: readonly GatewaySessionRow[],
  task?: WorkboardTaskSummary,
  resolution?: WorkboardSessionResolution,
): WorkboardLifecycle {
  const session = findWorkboardSession(card, sessions, resolution);
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
    const current =
      resolution?.key === normalizeSessionKeyForUiComparison(workboardCardSessionKey(card) ?? "");
    return {
      session: null,
      state:
        current && (resolution.status === "ambiguous" || resolution.status === "unavailable")
          ? resolution.status
          : "unknown",
    };
  }
  if (session.status === "queued") {
    return {
      session,
      state: "queued",
      targetStatus: "todo",
      sourceUpdatedAt: sessionUpdatedAtValue(session),
    };
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
