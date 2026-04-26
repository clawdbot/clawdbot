import { onAgentEvent } from "../../infra/agent-events.js";
import { setSafeTimeout } from "../../utils/timer-delay.js";

const AGENT_RUN_CACHE_TTL_MS = 10 * 60_000;
/**
 * Embedded runs can emit transient lifecycle `error` events while auth/model
 * failover is still in progress. Give errors a short grace window so a
 * subsequent `start` event can cancel premature terminal snapshots.
 */
const AGENT_RUN_ERROR_RETRY_GRACE_MS = 15_000;
/**
 * Some embedded runtimes emit an intermediate lifecycle `end` with
 * `aborted=true` immediately before retrying the same run. Hold timeout
 * snapshots briefly so `agent.wait` does not resolve to a stale timeout when a
 * final success is about to arrive.
 */
const AGENT_RUN_TIMEOUT_RETRY_GRACE_MS = 15_000;

const agentRunCache = new Map<string, AgentRunSnapshot>();
const agentRunStarts = new Map<string, number>();
const pendingAgentRunErrors = new Map<string, PendingAgentRunError>();
const pendingAgentRunTimeouts = new Map<string, PendingAgentRunTerminal>();
const agentRunWaiterCounts = new Map<string, number>();
let agentRunListenerStarted = false;

type AgentRunSnapshot = {
  runId: string;
  status: "ok" | "error" | "timeout";
  startedAt?: number;
  endedAt?: number;
  error?: string;
  ts: number;
};

type PendingAgentRunTerminal = {
  snapshot: AgentRunSnapshot;
  dueAt: number;
  timer: NodeJS.Timeout;
};

type PendingAgentRunError = PendingAgentRunTerminal;

function pruneAgentRunCache(now = Date.now()) {
  for (const [runId, entry] of agentRunCache) {
    if (now - entry.ts > AGENT_RUN_CACHE_TTL_MS) {
      agentRunCache.delete(runId);
    }
  }
}

function recordAgentRunSnapshot(entry: AgentRunSnapshot) {
  pruneAgentRunCache(entry.ts);
  agentRunCache.set(entry.runId, entry);
}

function clearPendingAgentRunError(runId: string) {
  const pending = pendingAgentRunErrors.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingAgentRunErrors.delete(runId);
}

function clearPendingAgentRunTimeout(runId: string) {
  const pending = pendingAgentRunTimeouts.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingAgentRunTimeouts.delete(runId);
}

function schedulePendingAgentRunError(snapshot: AgentRunSnapshot) {
  clearPendingAgentRunTimeout(snapshot.runId);
  clearPendingAgentRunError(snapshot.runId);
  const dueAt = Date.now() + AGENT_RUN_ERROR_RETRY_GRACE_MS;
  const timer = setTimeout(() => {
    const pending = pendingAgentRunErrors.get(snapshot.runId);
    if (!pending) {
      return;
    }
    pendingAgentRunErrors.delete(snapshot.runId);
    recordAgentRunSnapshot(pending.snapshot);
  }, AGENT_RUN_ERROR_RETRY_GRACE_MS);
  timer.unref?.();
  pendingAgentRunErrors.set(snapshot.runId, { snapshot, dueAt, timer });
}

function schedulePendingAgentRunTimeout(snapshot: AgentRunSnapshot) {
  clearPendingAgentRunError(snapshot.runId);
  clearPendingAgentRunTimeout(snapshot.runId);
  const dueAt = Date.now() + AGENT_RUN_TIMEOUT_RETRY_GRACE_MS;
  const timer = setTimeout(() => {
    const pending = pendingAgentRunTimeouts.get(snapshot.runId);
    if (!pending) {
      return;
    }
    pendingAgentRunTimeouts.delete(snapshot.runId);
    recordAgentRunSnapshot(pending.snapshot);
  }, AGENT_RUN_TIMEOUT_RETRY_GRACE_MS);
  timer.unref?.();
  pendingAgentRunTimeouts.set(snapshot.runId, { snapshot, dueAt, timer });
}

function getPendingAgentRunError(runId: string) {
  const pending = pendingAgentRunErrors.get(runId);
  if (!pending) {
    return undefined;
  }
  return {
    snapshot: pending.snapshot,
    dueAt: pending.dueAt,
  };
}

function getPendingAgentRunTimeout(runId: string) {
  const pending = pendingAgentRunTimeouts.get(runId);
  if (!pending) {
    return undefined;
  }
  return {
    snapshot: pending.snapshot,
    dueAt: pending.dueAt,
  };
}

function createSnapshotFromLifecycleEvent(params: {
  runId: string;
  phase: "end" | "error";
  data?: Record<string, unknown>;
}): AgentRunSnapshot {
  const { runId, phase, data } = params;
  const startedAt =
    typeof data?.startedAt === "number" ? data.startedAt : agentRunStarts.get(runId);
  const endedAt = typeof data?.endedAt === "number" ? data.endedAt : undefined;
  const error = typeof data?.error === "string" ? data.error : undefined;
  return {
    runId,
    status: phase === "error" ? "error" : data?.aborted ? "timeout" : "ok",
    startedAt,
    endedAt,
    error,
    ts: Date.now(),
  };
}

function ensureAgentRunListener() {
  if (agentRunListenerStarted) {
    return;
  }
  agentRunListenerStarted = true;
  onAgentEvent((evt) => {
    if (!evt) {
      return;
    }
    if (evt.stream !== "lifecycle") {
      return;
    }
    const phase = evt.data?.phase;
    if (phase === "start") {
      const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
      agentRunStarts.set(evt.runId, startedAt ?? Date.now());
      clearPendingAgentRunError(evt.runId);
      clearPendingAgentRunTimeout(evt.runId);
      // A new start means this run is active again (or retried). Drop stale
      // terminal snapshots so waiters don't resolve from old state.
      agentRunCache.delete(evt.runId);
      return;
    }
    if (phase !== "end" && phase !== "error") {
      return;
    }
    const snapshot = createSnapshotFromLifecycleEvent({
      runId: evt.runId,
      phase,
      data: evt.data,
    });
    agentRunStarts.delete(evt.runId);
    if (phase === "error") {
      schedulePendingAgentRunError(snapshot);
      return;
    }
    if (snapshot.status === "timeout") {
      schedulePendingAgentRunTimeout(snapshot);
      return;
    }
    clearPendingAgentRunError(evt.runId);
    clearPendingAgentRunTimeout(evt.runId);
    recordAgentRunSnapshot(snapshot);
  });
}

function getCachedAgentRun(runId: string) {
  pruneAgentRunCache();
  return agentRunCache.get(runId);
}

function addAgentRunWaiter(runId: string): () => void {
  agentRunWaiterCounts.set(runId, (agentRunWaiterCounts.get(runId) ?? 0) + 1);
  let removed = false;
  return () => {
    if (removed) {
      return;
    }
    removed = true;
    const nextCount = (agentRunWaiterCounts.get(runId) ?? 1) - 1;
    if (nextCount <= 0) {
      agentRunWaiterCounts.delete(runId);
      return;
    }
    agentRunWaiterCounts.set(runId, nextCount);
  };
}

export async function waitForAgentJob(params: {
  runId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  ignoreCachedSnapshot?: boolean;
}): Promise<AgentRunSnapshot | null> {
  const { runId, timeoutMs, signal, ignoreCachedSnapshot = false } = params;
  ensureAgentRunListener();
  const cached = ignoreCachedSnapshot ? undefined : getCachedAgentRun(runId);
  if (cached) {
    return cached;
  }
  if (timeoutMs <= 0 || signal?.aborted) {
    return null;
  }

  return await new Promise((resolve) => {
    let settled = false;
    let pendingErrorTimer: NodeJS.Timeout | undefined;
    let pendingTimeoutTimer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    let removeWaiter = () => {};

    const clearPendingErrorTimer = () => {
      if (!pendingErrorTimer) {
        return;
      }
      clearTimeout(pendingErrorTimer);
      pendingErrorTimer = undefined;
    };

    const clearPendingTimeoutTimer = () => {
      if (!pendingTimeoutTimer) {
        return;
      }
      clearTimeout(pendingTimeoutTimer);
      pendingTimeoutTimer = undefined;
    };

    const finish = (entry: AgentRunSnapshot | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearPendingErrorTimer();
      clearPendingTimeoutTimer();
      unsubscribe();
      removeWaiter();
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
      }
      resolve(entry);
    };

    const scheduleTerminalFinish = (
      kind: "error" | "timeout",
      snapshot: AgentRunSnapshot,
      delayMs: number,
    ) => {
      clearPendingErrorTimer();
      clearPendingTimeoutTimer();
      const timerRef = setSafeTimeout(() => {
        const latest = ignoreCachedSnapshot ? undefined : getCachedAgentRun(runId);
        if (latest) {
          finish(latest);
          return;
        }
        recordAgentRunSnapshot(snapshot);
        finish(snapshot);
      }, delayMs);
      timerRef.unref?.();
      if (kind === "error") {
        pendingErrorTimer = timerRef;
      } else {
        pendingTimeoutTimer = timerRef;
      }
    };

    const scheduleErrorFinish = (
      snapshot: AgentRunSnapshot,
      delayMs = AGENT_RUN_ERROR_RETRY_GRACE_MS,
    ) => {
      scheduleTerminalFinish("error", snapshot, delayMs);
    };

    const scheduleTimeoutFinish = (
      snapshot: AgentRunSnapshot,
      delayMs = AGENT_RUN_TIMEOUT_RETRY_GRACE_MS,
    ) => {
      scheduleTerminalFinish("timeout", snapshot, delayMs);
    };

    if (!ignoreCachedSnapshot) {
      const pendingError = getPendingAgentRunError(runId);
      if (pendingError) {
        scheduleErrorFinish(pendingError.snapshot, pendingError.dueAt - Date.now());
      }
      const pendingTimeout = getPendingAgentRunTimeout(runId);
      if (pendingTimeout) {
        scheduleTimeoutFinish(pendingTimeout.snapshot, pendingTimeout.dueAt - Date.now());
      }
    }

    const unsubscribe = onAgentEvent((evt) => {
      if (!evt || evt.stream !== "lifecycle") {
        return;
      }
      if (evt.runId !== runId) {
        return;
      }
      const phase = evt.data?.phase;
      if (phase === "start") {
        clearPendingErrorTimer();
        clearPendingTimeoutTimer();
        return;
      }
      if (phase !== "end" && phase !== "error") {
        return;
      }
      const latest = ignoreCachedSnapshot ? undefined : getCachedAgentRun(runId);
      if (latest) {
        finish(latest);
        return;
      }
      const snapshot = createSnapshotFromLifecycleEvent({
        runId: evt.runId,
        phase,
        data: evt.data,
      });
      if (phase === "error") {
        scheduleErrorFinish(snapshot);
        return;
      }
      if (snapshot.status === "timeout") {
        scheduleTimeoutFinish(snapshot);
        return;
      }
      recordAgentRunSnapshot(snapshot);
      finish(snapshot);
    });
    removeWaiter = addAgentRunWaiter(runId);

    const timer = setSafeTimeout(() => finish(null), timeoutMs);
    onAbort = () => finish(null);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

ensureAgentRunListener();

export const __testing = {
  getWaiterCount(runId?: string): number {
    if (runId) {
      return agentRunWaiterCounts.get(runId) ?? 0;
    }
    let total = 0;
    for (const count of agentRunWaiterCounts.values()) {
      total += count;
    }
    return total;
  },
  resetWaiters(): void {
    agentRunWaiterCounts.clear();
  },
};
