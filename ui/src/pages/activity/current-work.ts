import type { SessionsListResult } from "../../api/types.ts";
import { readSessionChangedEvent } from "../../lib/sessions/reconcile.ts";
import { normalizeAgentId, resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";

export type CurrentWorkChange = Pick<
  NonNullable<ReturnType<typeof readSessionChangedEvent>>,
  | "key"
  | "agentId"
  | "sessionId"
  | "runId"
  | "reason"
  | "updatedAt"
  | "hasActiveRun"
  | "activeRunIds"
  | "status"
>;

export function currentWorkIdentity(session: {
  key: string;
  agentId?: string | null;
  sessionId?: string;
}): string {
  const identity = resolveUiConversationIdentity({}, session.key, session.agentId ?? undefined);
  const agentId = session.agentId ?? identity.agentId;
  // A raw global in one agent and a literal agent:<id>:global are different sessions.
  return JSON.stringify([
    agentId ? normalizeAgentId(agentId) : null,
    identity.sessionKey,
    session.sessionId ?? null,
  ]);
}

export function readCurrentWorkChange(payload: unknown): CurrentWorkChange | null {
  const change = readSessionChangedEvent(payload);
  if (
    !change?.sessionId ||
    (change.hasActiveRun === null &&
      change.activeRunIds === undefined &&
      change.status === null &&
      change.reason !== "delete")
  ) {
    return null;
  }
  return {
    key: change.key,
    agentId: change.agentId,
    sessionId: change.sessionId,
    runId: change.runId,
    reason: change.reason,
    updatedAt: change.updatedAt,
    hasActiveRun: change.hasActiveRun,
    activeRunIds: change.activeRunIds,
    status: change.status,
  };
}

export function reconcileCurrentWork(
  result: SessionsListResult,
  changes: Iterable<CurrentWorkChange>,
): { result: SessionsListResult; requiresRefresh: boolean; canPublish: boolean } {
  const rows = new Map(
    result.sessions.map((row) => [currentWorkIdentity(row), { row, requiresRefresh: false }]),
  );
  const unseenActive = new Set<string>();
  for (const change of changes) {
    const identity = currentWorkIdentity(change);
    const state = rows.get(identity);
    const activeStatus =
      change.status === "running" || change.status === "queued" ? change.status : undefined;
    const active =
      change.hasActiveRun === true || (change.hasActiveRun !== false && activeStatus !== undefined);
    if (!state) {
      if (active) {
        unseenActive.add(identity);
      } else if (change.hasActiveRun === false || change.reason === "delete") {
        unseenActive.delete(identity);
      }
      continue;
    }
    const { row } = state;
    if (change.updatedAt !== null && (row.updatedAt ?? 0) > change.updatedAt) {
      continue;
    }
    const next = { ...row, updatedAt: change.updatedAt ?? row.updatedAt };
    if (change.reason === "delete") {
      next.hasActiveRun = false;
      next.activeRunIds = [];
    } else if (active) {
      next.hasActiveRun = true;
      next.status = activeStatus ?? (row.status === "queued" ? "queued" : "running");
      if (change.activeRunIds !== undefined) {
        // Null explicitly retires a previously exact set when only liveness is known.
        next.activeRunIds = change.activeRunIds ?? undefined;
      } else if (change.runId && !row.activeRunIds?.includes(change.runId)) {
        next.activeRunIds = undefined;
      }
    } else {
      const terminal = change.hasActiveRun === false || change.status !== null;
      if (
        terminal &&
        row.hasActiveRun === true &&
        change.runId &&
        !row.activeRunIds?.includes(change.runId)
      ) {
        // A single old run cannot retire a replacement or an unidentified active run.
        state.requiresRefresh = true;
        continue;
      }
      if (
        (change.hasActiveRun === false && (change.activeRunIds !== undefined || !change.runId)) ||
        change.activeRunIds?.length === 0
      ) {
        next.hasActiveRun = false;
        next.activeRunIds = [];
      } else if (terminal) {
        const runIds = change.activeRunIds ?? row.activeRunIds;
        if (!change.runId || !runIds?.includes(change.runId)) {
          state.requiresRefresh = row.hasActiveRun === true;
          continue;
        }
        next.activeRunIds = runIds.filter((id) => id !== change.runId);
        next.hasActiveRun = next.activeRunIds.length > 0;
      } else if (change.activeRunIds !== undefined) {
        next.activeRunIds = change.activeRunIds ?? undefined;
      }
    }
    state.row = next;
    state.requiresRefresh = false;
  }
  const current = [...rows.values()].filter(({ row }) => row.hasActiveRun === true);
  const sessions = current.map(({ row }) => row);
  const canPublish = !current.some((state) => state.requiresRefresh);
  const requiresRefresh = !canPublish || (!result.hasMore && unseenActive.size > 0);
  return { result: { ...result, count: sessions.length, sessions }, requiresRefresh, canPublish };
}
