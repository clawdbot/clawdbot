// Control UI chat module implements run lifecycle behavior.
import { resetToolStream, type CompactionStatus, type FallbackStatus } from "../app-tool-stream.ts";
import { uiSessionRowMatchesSelectedChat } from "../session-key.ts";
import { isSessionRunActive } from "../session-run-state.ts";
import type { GatewaySessionRow, SessionRunStatus, SessionsListResult } from "../types.ts";

export const CHAT_RUN_STATUS_TOAST_DURATION_MS = 5_000;

export type ChatRunUiStatus = {
  phase: "done" | "interrupted";
  runId: string | null;
  sessionKey: string;
  occurredAt: number;
};

export type LocalTerminalReconcile = {
  sessionKey: string;
  runId: string | null;
  phase: ChatRunUiStatus["phase"];
  sessionStatus: SessionRunStatus;
  occurredAt: number;
};

// A terminal chat event clears local run state before the periodic
// sessions.list poll catches up. Within this window a stale "active" row for
// the just-completed selected session is treated as poll lag and reconciled
// back to terminal, so the composer does not snap back to in-progress. (#87875)
export const STALE_ACTIVE_ROW_RECONCILE_WINDOW_MS = 10_000;

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

type RunLifecycleHost = Omit<Partial<Parameters<typeof resetToolStream>[0]>, "hello"> & {
  sessionKey: string;
  agentsList?: { mainKey?: string | null } | null;
  hello?: { snapshot?: unknown } | null;
  chatRunId?: string | null;
  chatStream?: string | null;
  chatStreamStartedAt?: number | null;
  chatSideResultTerminalRuns?: Set<string>;
  compactionStatus?: CompactionStatus | null;
  compactionClearTimer?: TimerHandle | number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: TimerHandle | number | null;
  chatRunStatus?: ChatRunUiStatus | null;
  chatRunStatusClearTimer?: TimerHandle | number | null;
  sessionsResult?: SessionsListResult | null;
  lastLocalTerminalReconcile?: LocalTerminalReconcile | null;
  requestUpdate?: () => void;
};

type ReconcileOptions = {
  outcome?: ChatRunUiStatus["phase"];
  sessionStatus?: SessionRunStatus;
  runId?: string | null;
  sessionKey?: string | null;
  sessionKeys?: readonly (string | null | undefined)[];
  clearLocalRun?: boolean;
  clearChatStream?: boolean;
  clearIndicators?: boolean;
  clearToolStream?: boolean;
  clearSideResultTerminalRuns?: boolean;
  clearRunStatus?: boolean;
  publishRunStatus?: boolean;
  armLocalTerminalReconcile?: boolean;
};

function toSessionKey(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function clearTimer(timer: TimerHandle | number | null | undefined) {
  if (timer != null) {
    globalThis.clearTimeout(timer as TimerHandle);
  }
}

function canResetToolStream(host: RunLifecycleHost): host is Parameters<typeof resetToolStream>[0] {
  return (
    host.toolStreamById instanceof Map &&
    Array.isArray(host.toolStreamOrder) &&
    Array.isArray(host.chatToolMessages) &&
    Array.isArray(host.chatStreamSegments)
  );
}

function clearChatRunStatus(host: RunLifecycleHost) {
  clearTimer(host.chatRunStatusClearTimer);
  host.chatRunStatusClearTimer = null;
  host.chatRunStatus = null;
}

function scheduleRunStatusClear(host: RunLifecycleHost, status: ChatRunUiStatus) {
  clearTimer(host.chatRunStatusClearTimer);
  host.chatRunStatusClearTimer = globalThis.setTimeout(() => {
    const current = host.chatRunStatus;
    if (
      current?.phase !== status.phase ||
      current.runId !== status.runId ||
      current.sessionKey !== status.sessionKey ||
      current.occurredAt !== status.occurredAt
    ) {
      return;
    }
    host.chatRunStatus = null;
    host.chatRunStatusClearTimer = null;
    host.requestUpdate?.();
  }, CHAT_RUN_STATUS_TOAST_DURATION_MS);
}

function clearRunIndicators(host: RunLifecycleHost) {
  clearTimer(host.compactionClearTimer);
  host.compactionClearTimer = null;
  if (host.compactionStatus) {
    host.compactionStatus = null;
  }
  clearTimer(host.fallbackClearTimer);
  host.fallbackClearTimer = null;
  if (host.fallbackStatus) {
    host.fallbackStatus = null;
  }
}

function sessionKeysFor(host: RunLifecycleHost, options: ReconcileOptions): Set<string> {
  const keys = new Set<string>();
  const primary = toSessionKey(options.sessionKey) ?? host.sessionKey;
  if (primary) {
    keys.add(primary);
  }
  for (const key of options.sessionKeys ?? []) {
    const normalized = toSessionKey(key);
    if (normalized) {
      keys.add(normalized);
    }
  }
  return keys;
}

function reconcileSessionRows(
  host: RunLifecycleHost,
  options: ReconcileOptions,
  occurredAt: number,
) {
  if (!options.outcome || !host.sessionsResult) {
    return;
  }
  const keys = sessionKeysFor(host, options);
  if (keys.size === 0) {
    return;
  }
  const status =
    options.sessionStatus ?? (options.outcome === "done" ? ("done" as const) : ("killed" as const));
  let changed = false;
  const sessions = host.sessionsResult.sessions.map((row) => {
    if (!keys.has(row.key)) {
      return row;
    }
    const next = {
      ...row,
      hasActiveRun: false,
      status,
      endedAt: row.endedAt ?? occurredAt,
    };
    if (status === "killed") {
      next.abortedLastRun = true;
    }
    if (typeof next.startedAt === "number" && typeof next.endedAt === "number") {
      next.runtimeMs = Math.max(0, next.endedAt - next.startedAt);
    }
    changed = true;
    return next;
  });
  if (changed) {
    host.sessionsResult = { ...host.sessionsResult, sessions };
  }
}

export function reconcileChatRunLifecycle(host: RunLifecycleHost, options: ReconcileOptions = {}) {
  const occurredAt = Date.now();
  const runId = options.runId ?? host.chatRunId ?? null;
  const sessionKey = toSessionKey(options.sessionKey) ?? host.sessionKey;

  if (options.clearIndicators ?? true) {
    clearRunIndicators(host);
  }
  if (options.clearChatStream) {
    host.chatStream = null;
    host.chatStreamStartedAt = null;
  }
  if (options.clearLocalRun) {
    host.chatRunId = null;
  }
  if (options.clearSideResultTerminalRuns) {
    host.chatSideResultTerminalRuns?.clear();
  }
  if (options.clearToolStream && canResetToolStream(host)) {
    resetToolStream(host);
  }
  if (options.outcome) {
    const status: ChatRunUiStatus = {
      phase: options.outcome,
      runId,
      sessionKey,
      occurredAt,
    };
    reconcileSessionRows(host, options, occurredAt);
    if (options.armLocalTerminalReconcile) {
      host.lastLocalTerminalReconcile = {
        sessionKey,
        runId,
        phase: options.outcome,
        sessionStatus: options.sessionStatus ?? (options.outcome === "done" ? "done" : "killed"),
        occurredAt,
      };
    }
    if (options.publishRunStatus !== false) {
      host.chatRunStatus = status;
      scheduleRunStatusClear(host, status);
    }
  } else if (options.clearRunStatus) {
    clearChatRunStatus(host);
  }
  host.requestUpdate?.();
}

function currentSessionRow(host: RunLifecycleHost) {
  return host.sessionsResult?.sessions.find((row) => row.key === host.sessionKey);
}

// After a terminal chat event clears local run state, a racing sessions.list
// refresh can still carry a stale "active" row for the session we just
// finished, which would drive the composer back to in-progress. Re-apply
// terminal to that row — but only while we hold a recent LOCAL terminal
// reconcile for the currently selected session, so a genuinely recovered
// active run (e.g. opening WebChat to a session already running elsewhere) is
// never cleared. (#87875)
function reconcileStaleSelectedSessionRunAfterLocalCompletion(host: RunLifecycleHost): boolean {
  const recent = host.lastLocalTerminalReconcile;
  if (!recent || recent.sessionKey !== host.sessionKey) {
    return false;
  }
  if (Date.now() - recent.occurredAt > STALE_ACTIVE_ROW_RECONCILE_WINDOW_MS) {
    host.lastLocalTerminalReconcile = null;
    return false;
  }
  const row = currentSessionRow(host);
  if (!row || !isSessionRunActive(row)) {
    // No row, or the server already reflects a non-active state — the poll has
    // caught up, so stop suppressing.
    host.lastLocalTerminalReconcile = null;
    return false;
  }
  if (typeof row.startedAt === "number" && row.startedAt > recent.occurredAt) {
    host.lastLocalTerminalReconcile = null;
    return false;
  }
  reconcileSessionRows(
    host,
    { outcome: recent.phase, sessionStatus: recent.sessionStatus, sessionKey: recent.sessionKey },
    Date.now(),
  );
  host.requestUpdate?.();
  return true;
}

export function reconcileChatRunFromCurrentSessionRow(
  host: RunLifecycleHost,
  options: { publishRunStatus?: boolean } = {},
): boolean {
  if (!host.chatRunId && host.chatStream == null) {
    return reconcileStaleSelectedSessionRunAfterLocalCompletion(host);
  }
  const row = currentSessionRow(host);
  if (!row) {
    return false;
  }
  return reconcileChatRunFromSessionRow(host, row, options);
}

function isSessionRowForSelectedChat(
  host: RunLifecycleHost,
  rowKey: string,
  sessionKey: string,
): boolean {
  return uiSessionRowMatchesSelectedChat(host, rowKey, sessionKey);
}

export function reconcileChatRunFromSessionRow(
  host: RunLifecycleHost,
  row: GatewaySessionRow,
  options: { publishRunStatus?: boolean } = {},
): boolean {
  if (!isSessionRowForSelectedChat(host, row.key, host.sessionKey)) {
    return false;
  }
  if (!host.chatRunId && host.chatStream == null) {
    return false;
  }
  if (isSessionRunActive(row)) {
    return false;
  }
  const terminalStatus = row.status !== undefined;
  if (row.hasActiveRun !== false && !terminalStatus) {
    return false;
  }
  reconcileChatRunLifecycle(host, {
    outcome: row.status === "done" ? "done" : "interrupted",
    sessionStatus: row.status === "done" ? "done" : (row.status ?? "killed"),
    runId: host.chatRunId,
    sessionKey: host.sessionKey,
    sessionKeys: [row.key],
    clearLocalRun: true,
    clearChatStream: true,
    publishRunStatus: options.publishRunStatus,
  });
  return true;
}
