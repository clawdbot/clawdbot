import type { GatewaySessionRow } from "../../api/types.ts";
import { isFailedSessionStatus, staleSessionState, workboardCardSessionKey } from "./card-state.ts";
import { isRecord } from "./normalization-utils.ts";
import { getWorkboardRuntime, type WorkboardHost } from "./runtime.ts";
import { sessionUpdatedAtValue, taskLifecycleSourceUpdatedAt } from "./task-links.ts";
import type {
  WorkboardCard,
  WorkboardExecutionStatus,
  WorkboardLifecycle,
  WorkboardStatus,
  WorkboardTaskSummary,
} from "./types.ts";

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

export function shouldSyncCardStatus(
  card: WorkboardCard,
  targetStatus: WorkboardStatus | undefined,
) {
  if (!targetStatus || card.status === targetStatus) {
    return false;
  }
  if (targetStatus === "running") {
    return card.status === "backlog" || card.status === "todo" || card.status === "ready";
  }
  if (targetStatus === "blocked" || targetStatus === "review") {
    return card.status === "running" || card.status === "todo" || card.status === "ready";
  }
  return false;
}

function pendingStatusTransitionMap(host: WorkboardHost) {
  return getWorkboardRuntime(host).pendingStatusTransitions;
}

export function recordPendingStatusTransition(
  host: WorkboardHost,
  card: WorkboardCard | undefined,
  status: WorkboardStatus,
): boolean {
  if (!card || card.status === status) {
    return false;
  }
  pendingStatusTransitionMap(host).add(card.id);
  return true;
}

export function clearPendingStatusTransition(
  host: WorkboardHost,
  cardId: string,
  recorded: boolean,
) {
  if (!recorded) {
    return;
  }
  getWorkboardRuntime(host).pendingStatusTransitions.delete(cardId);
}

export function hasPendingStatusTransition(host: WorkboardHost, cardId: string): boolean {
  return getWorkboardRuntime(host).pendingStatusTransitions.has(cardId);
}

export function shouldSkipStaleLifecycleStatus(
  card: WorkboardCard,
  lifecycle: WorkboardLifecycle,
): boolean {
  if (lifecycle.sourceUpdatedAt === undefined) {
    return false;
  }
  const lifecycleStatusSourceUpdatedAt = card.metadata?.lifecycleStatusSourceUpdatedAt;
  if (lifecycleStatusSourceUpdatedAt !== undefined) {
    return lifecycle.sourceUpdatedAt < lifecycleStatusSourceUpdatedAt;
  }
  const statusTransitionAt = latestStatusTransitionAt(card);
  return statusTransitionAt !== undefined && lifecycle.sourceUpdatedAt < statusTransitionAt;
}

export function shouldSkipLifecycleStatusWrite(
  host: WorkboardHost,
  card: WorkboardCard,
  lifecycle: WorkboardLifecycle,
): boolean {
  return (
    hasPendingStatusTransition(host, card.id) || shouldSkipStaleLifecycleStatus(card, lifecycle)
  );
}

function latestStatusTransitionAt(card: WorkboardCard): number | undefined {
  for (let index = (card.events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = card.events?.[index];
    if (
      (event?.kind === "moved" || event?.kind === "created") &&
      ((event.kind === "created" && card.status !== "todo") ||
        (event.kind === "moved" && event.fromStatus !== event.toStatus)) &&
      event.toStatus === card.status &&
      typeof event.at === "number" &&
      Number.isFinite(event.at)
    ) {
      return event.at;
    }
  }
  return undefined;
}

export function executionStatusForLifecycle(
  lifecycle: WorkboardLifecycle,
): WorkboardExecutionStatus | undefined {
  switch (lifecycle.state) {
    case "running":
    case "stale":
      return "running";
    case "succeeded":
      return "review";
    case "failed":
      return "blocked";
    case "missing":
      return undefined;
    case "idle":
      return "idle";
    case "unlinked":
      return undefined;
  }
  return undefined;
}

export function shouldSyncExecutionStatus(
  card: WorkboardCard,
  targetStatus: WorkboardExecutionStatus | undefined,
) {
  return Boolean(card.execution && targetStatus && card.execution.status !== targetStatus);
}

export function lifecycleSyncKey(card: WorkboardCard, lifecycle: WorkboardLifecycle): string {
  const session = lifecycle.session;
  return [
    card.id,
    card.status,
    card.updatedAt,
    lifecycle.targetStatus ?? "",
    lifecycle.state,
    session?.status ?? "",
    session?.hasActiveRun === true ? "active" : "idle",
    session?.updatedAt ?? "",
    lifecycle.sourceUpdatedAt ?? "",
    card.execution?.status ?? "",
    card.execution?.updatedAt ?? "",
  ].join(":");
}

export function getLifecycleSyncKeys(host: WorkboardHost): Map<string, string> {
  return getWorkboardRuntime(host).lifecycleSyncKeys;
}

export function mergePatchMetadata(
  patch: Record<string, unknown>,
  metadata: Record<string, unknown>,
) {
  patch.metadata = {
    ...(isRecord(patch.metadata) ? patch.metadata : {}),
    ...metadata,
  };
}
