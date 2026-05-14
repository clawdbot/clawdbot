import { resetToolStream, type CompactionStatus, type FallbackStatus } from "../app-tool-stream.ts";
import type { SessionRunStatus, SessionsListResult } from "../types.ts";

export const CHAT_RUN_STATUS_TOAST_DURATION_MS = 5_000;

export type ChatRunUiStatus = {
  phase: "done" | "interrupted";
  runId: string | null;
  sessionKey: string;
  occurredAt: number;
};

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

type RunLifecycleHost = Partial<Parameters<typeof resetToolStream>[0]> & {
  sessionKey: string;
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
    host.chatRunStatus = status;
    scheduleRunStatusClear(host, status);
  } else if (options.clearRunStatus) {
    clearChatRunStatus(host);
  }
  host.requestUpdate?.();
}

function currentSessionRow(host: RunLifecycleHost) {
  return host.sessionsResult?.sessions.find((row) => row.key === host.sessionKey);
}

export function reconcileChatRunFromCurrentSessionRow(host: RunLifecycleHost): boolean {
  if (!host.chatRunId && host.chatStream == null) {
    return false;
  }
  const row = currentSessionRow(host);
  if (!row) {
    return false;
  }
  if (row.hasActiveRun === true || row.status === "running") {
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
    clearLocalRun: true,
    clearChatStream: true,
  });
  return true;
}
