// Tracks heartbeat wake requests, busy skips, and retry timing.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import { normalizeHeartbeatWakeReason } from "./heartbeat-reason.js";

export type HeartbeatRunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string; retryAtMs?: number }
  | { status: "failed"; reason: string };

export const HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT = "requests-in-flight";
export const HEARTBEAT_SKIP_CRON_IN_PROGRESS = "cron-in-progress";
export const HEARTBEAT_SKIP_LANES_BUSY = "lanes-busy";
const RETRYABLE_BUSY_SKIP_REASONS = new Set([
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  HEARTBEAT_SKIP_LANES_BUSY,
]);
const RETRYABLE_GUARD_SKIP_REASONS = new Set(["not-due", "min-spacing", "flood"]);

export function isRetryableHeartbeatBusySkipReason(reason: string): boolean {
  return RETRYABLE_BUSY_SKIP_REASONS.has(reason);
}

export type HeartbeatWakeIntent = "scheduled" | "task" | "event" | "immediate" | "manual";

export type HeartbeatWakeSource =
  | "interval"
  | "manual"
  | "exec-event"
  | "notifications-event"
  | "cron"
  | "hook"
  | "background-task"
  | "background-task-blocked"
  | "acp-spawn"
  | "session-state"
  | "cli-watchdog"
  | "restart-sentinel"
  | "retry"
  | "other";

type HeartbeatWakeOverride = {
  target?: string;
  to?: string | undefined;
  accountId?: string | undefined;
};

/** Cron-owned periodic work carried directly into a guarded heartbeat turn. */
export type HeartbeatScheduledTask = {
  jobId: string;
  name: string;
  prompt: string;
};

export type HeartbeatWakeRequest = {
  source: HeartbeatWakeSource;
  intent: HeartbeatWakeIntent;
  reason?: string;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: HeartbeatWakeOverride;
  /** Persisted cron monitor cadence carried with a scheduled heartbeat tick. */
  scheduledEveryMs?: number;
  /** Persisted cron monitor phase anchor carried with a scheduled heartbeat tick. */
  scheduledAnchorMs?: number;
  tasks?: readonly HeartbeatScheduledTask[];
  /** Internal marker for work retained after a spacing/cooldown deferral. */
  retainedWork?: boolean;
};

export type HeartbeatWakeHandler = (opts: HeartbeatWakeRequest) => Promise<HeartbeatRunResult>;

let heartbeatsEnabled = true;

export function setHeartbeatsEnabled(enabled: boolean) {
  heartbeatsEnabled = enabled;
}

export function areHeartbeatsEnabled(): boolean {
  return heartbeatsEnabled;
}

type PendingWakeReason = {
  source: HeartbeatWakeSource;
  intent: HeartbeatWakeIntent;
  reason: string;
  priority: number;
  requestedAt: number;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: HeartbeatWakeOverride;
  scheduledEveryMs?: number;
  scheduledAnchorMs?: number;
  tasks?: HeartbeatScheduledTask[];
  /** Earliest instant at which this retained wake class may be dispatched. */
  notBeforeMs?: number;
  /** The wake was retained after a spacing/cooldown guard deferred its work. */
  guardRetry?: boolean;
};

type PendingWakeGroup = {
  task?: PendingWakeReason;
  scheduled?: PendingWakeReason;
  event?: PendingWakeReason;
  /** Busy/error backoff blocks every wake class for this target. */
  blockedUntilMs?: number;
};

let handler: HeartbeatWakeHandler | null = null;
let handlerGeneration = 0;
// One bounded group per target owns every pending/retry class for that agent/session.
const pendingWakes = new Map<string, PendingWakeGroup>();
let scheduled = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let timerDueAt: number | null = null;

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1_000;
const REASON_PRIORITY = {
  RETRY: 0,
  INTERVAL: 1,
  DEFAULT: 2,
  ACTION: 3,
} as const;

function resolveWakePriority(params: {
  source: HeartbeatWakeSource;
  intent: HeartbeatWakeIntent;
  reason: string;
}): number {
  if (params.intent === "manual" || params.intent === "immediate") {
    return REASON_PRIORITY.ACTION;
  }
  if (params.source === "retry" || params.reason === "retry") {
    return REASON_PRIORITY.RETRY;
  }
  if (
    params.intent === "scheduled" ||
    params.source === "interval" ||
    params.reason === "interval"
  ) {
    return REASON_PRIORITY.INTERVAL;
  }
  return REASON_PRIORITY.DEFAULT;
}

function normalizeWakeReason(reason?: string): string {
  return normalizeHeartbeatWakeReason(reason);
}

function normalizeWakeTarget(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed || undefined;
}

function getWakeTargetBaseKey(params: { agentId?: string; sessionKey?: string }) {
  const agentId = normalizeWakeTarget(params.agentId);
  const sessionKey = normalizeWakeTarget(params.sessionKey);
  return `${agentId ?? ""}::${sessionKey ?? ""}`;
}

function mergePendingWakeReasons(
  previous: PendingWakeReason,
  next: PendingWakeReason,
): PendingWakeReason {
  const tasksByJobId = new Map<string, HeartbeatScheduledTask>();
  for (const task of previous.tasks ?? []) {
    tasksByJobId.set(task.jobId, task);
  }
  for (const task of next.tasks ?? []) {
    tasksByJobId.set(task.jobId, task);
  }
  // Concurrent cron ticks can arrive in either order; stable job order keeps the model prompt cacheable.
  const mergedTasks = Array.from(tasksByJobId.values()).toSorted((left, right) =>
    left.jobId.localeCompare(right.jobId),
  );
  const mixedTaskPair = (previous.intent === "task") !== (next.intent === "task");
  const preferred = mixedTaskPair
    ? previous.intent === "task"
      ? previous
      : next
    : next.priority > previous.priority ||
        (next.priority === previous.priority && next.requestedAt >= previous.requestedAt)
      ? next
      : previous;
  const other = preferred === previous ? next : previous;
  const scheduledEveryMs = preferred.scheduledEveryMs ?? other.scheduledEveryMs;
  const scheduledAnchorMs = preferred.scheduledAnchorMs ?? other.scheduledAnchorMs;
  const merged: PendingWakeReason = {
    ...preferred,
    ...(previous.notBeforeMs !== undefined || next.notBeforeMs !== undefined
      ? {
          requestedAt: Math.min(previous.requestedAt, next.requestedAt),
          notBeforeMs: Math.max(previous.notBeforeMs ?? 0, next.notBeforeMs ?? 0),
        }
      : {}),
    ...((preferred.heartbeat ?? other.heartbeat)
      ? { heartbeat: preferred.heartbeat ?? other.heartbeat }
      : {}),
    ...(scheduledEveryMs !== undefined ? { scheduledEveryMs } : {}),
    ...(scheduledAnchorMs !== undefined ? { scheduledAnchorMs } : {}),
    ...(mergedTasks.length ? { tasks: mergedTasks } : {}),
  };
  if (previous.guardRetry || next.guardRetry) {
    merged.guardRetry = true;
  } else {
    delete merged.guardRetry;
  }
  return merged;
}

function takePendingWakeBatch(now = Date.now()): PendingWakeReason[] {
  const readyGroups: PendingWakeGroup[] = [];
  for (const [targetKey, group] of pendingWakes) {
    if (group.blockedUntilMs !== undefined && group.blockedUntilMs > now) {
      continue;
    }
    const ready: PendingWakeGroup = {};
    const remaining: PendingWakeGroup = {};
    for (const slot of ["task", "scheduled", "event"] as const) {
      const pending = group[slot];
      if (!pending) {
        continue;
      }
      if (pending.notBeforeMs === undefined || pending.notBeforeMs <= now) {
        ready[slot] = pending;
      } else {
        remaining[slot] = pending;
      }
    }
    if (remaining.task || remaining.scheduled || remaining.event) {
      pendingWakes.set(targetKey, remaining);
    } else {
      pendingWakes.delete(targetKey);
    }
    if (ready.task || ready.scheduled || ready.event) {
      readyGroups.push(ready);
    }
  }

  const batch: PendingWakeReason[] = [];
  for (const group of readyGroups) {
    if (group.task) {
      // A due base heartbeat is covered by the task prompt's appended monitor
      // scratch. Dispatching both lets the base run consume min-spacing and
      // silently lose the task, so the scheduled wake must join this turn.
      const taskWake = group.scheduled
        ? mergePendingWakeReasons(group.scheduled, group.task)
        : group.task;
      if (group.event) {
        // Retained work keeps its original age. Sorting it ahead of fresh work
        // prevents a periodic task stream from starving an older event forever.
        batch.push(
          ...[taskWake, group.event].toSorted((left, right) => {
            if (left.guardRetry !== right.guardRetry) {
              return left.guardRetry ? -1 : 1;
            }
            if (left.requestedAt !== right.requestedAt) {
              return left.requestedAt - right.requestedAt;
            }
            return 0;
          }),
        );
      } else {
        batch.push(taskWake);
      }
      continue;
    }
    if (group.event) {
      batch.push(
        group.scheduled ? mergePendingWakeReasons(group.scheduled, group.event) : group.event,
      );
    } else if (group.scheduled) {
      batch.push(group.scheduled);
    }
  }
  return batch;
}

function queuePendingWakeReason(params: {
  source: HeartbeatWakeSource;
  intent: HeartbeatWakeIntent;
  reason?: string;
  requestedAt?: number;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: HeartbeatWakeOverride;
  scheduledEveryMs?: number;
  scheduledAnchorMs?: number;
  tasks?: readonly HeartbeatScheduledTask[];
  notBeforeMs?: number;
  blockTargetUntilMs?: number;
  guardRetry?: boolean;
}) {
  const requestedAt = params.requestedAt ?? Date.now();
  const normalizedReason = normalizeWakeReason(params.reason);
  const normalizedAgentId = normalizeWakeTarget(params.agentId);
  const normalizedSessionKey = normalizeWakeTarget(params.sessionKey);
  const wakeTargetKey = getWakeTargetBaseKey({
    agentId: normalizedAgentId,
    sessionKey: normalizedSessionKey,
  });
  const next: PendingWakeReason = {
    source: params.source,
    intent: params.intent,
    reason: normalizedReason,
    priority: resolveWakePriority({
      source: params.source,
      intent: params.intent,
      reason: normalizedReason,
    }),
    requestedAt,
    agentId: normalizedAgentId,
    sessionKey: normalizedSessionKey,
    heartbeat: params.heartbeat,
    scheduledEveryMs: params.scheduledEveryMs,
    scheduledAnchorMs: params.scheduledAnchorMs,
    ...(params.tasks?.length ? { tasks: [...params.tasks] } : {}),
    ...(params.notBeforeMs === undefined ? {} : { notBeforeMs: params.notBeforeMs }),
    ...(params.guardRetry ? { guardRetry: true } : {}),
  };
  const group = pendingWakes.get(wakeTargetKey) ?? {};
  if (params.blockTargetUntilMs !== undefined) {
    group.blockedUntilMs = Math.max(group.blockedUntilMs ?? 0, params.blockTargetUntilMs);
  }
  const slot =
    params.intent === "task" ? "task" : params.intent === "scheduled" ? "scheduled" : "event";
  const previous = group[slot];
  if (!previous) {
    group[slot] = next;
    pendingWakes.set(wakeTargetKey, group);
    return;
  }
  group[slot] = mergePendingWakeReasons(previous, next);
  pendingWakes.set(wakeTargetKey, group);
}

function schedule(coalesceMs: number) {
  const delay = resolveTimerTimeoutMs(coalesceMs, DEFAULT_COALESCE_MS, 0);
  const dueAt = Date.now() + delay;
  if (timer) {
    // If existing timer fires sooner or at the same time, keep it.
    if (typeof timerDueAt === "number" && timerDueAt <= dueAt) {
      return;
    }
    // New request needs to fire sooner — preempt the existing timer.
    clearTimeout(timer);
    timer = null;
    timerDueAt = null;
  }
  timerDueAt = dueAt;
  timer = setTimeout(() => {
    void (async () => {
      timer = null;
      timerDueAt = null;
      scheduled = false;
      const active = handler;
      if (!active) {
        return;
      }
      if (running) {
        scheduled = true;
        schedule(delay);
        return;
      }

      const pendingBatch = takePendingWakeBatch();
      running = true;
      try {
        for (const pendingWake of pendingBatch) {
          const wakeOpts = {
            source: pendingWake.source,
            intent: pendingWake.intent,
            reason: pendingWake.reason ?? undefined,
            ...(pendingWake.agentId ? { agentId: pendingWake.agentId } : {}),
            ...(pendingWake.sessionKey ? { sessionKey: pendingWake.sessionKey } : {}),
            ...(pendingWake.heartbeat ? { heartbeat: pendingWake.heartbeat } : {}),
            ...(pendingWake.scheduledEveryMs !== undefined
              ? { scheduledEveryMs: pendingWake.scheduledEveryMs }
              : {}),
            ...(pendingWake.scheduledAnchorMs !== undefined
              ? { scheduledAnchorMs: pendingWake.scheduledAnchorMs }
              : {}),
            ...(pendingWake.tasks ? { tasks: pendingWake.tasks } : {}),
            ...(pendingWake.guardRetry ? { retainedWork: true } : {}),
          };
          // Each wake is detached process work: admit the whole handler before
          // it can mutate sessions or commitments, and keep it visible until done.
          const res = await runWithGatewayIndependentRootWorkAdmission(async () =>
            active(wakeOpts),
          );
          if (res.status === "skipped" && isRetryableHeartbeatBusySkipReason(res.reason)) {
            // The target runtime is busy; retry this wake target soon.
            queuePendingWakeReason({
              source: pendingWake.source,
              intent: pendingWake.intent,
              reason: pendingWake.reason ?? "retry",
              agentId: pendingWake.agentId,
              sessionKey: pendingWake.sessionKey,
              heartbeat: pendingWake.heartbeat,
              scheduledEveryMs: pendingWake.scheduledEveryMs,
              scheduledAnchorMs: pendingWake.scheduledAnchorMs,
              tasks: pendingWake.tasks,
              requestedAt: pendingWake.requestedAt,
              blockTargetUntilMs: Date.now() + DEFAULT_RETRY_MS,
            });
            schedule(DEFAULT_RETRY_MS);
          } else if (
            res.status === "skipped" &&
            RETRYABLE_GUARD_SKIP_REASONS.has(res.reason) &&
            (pendingWake.tasks?.length ||
              pendingWake.intent === "task" ||
              pendingWake.intent === "event" ||
              pendingWake.intent === "immediate")
          ) {
            // A wake that carries work the turn prompt depends on — a task
            // payload or an unprocessed event — may be deferred by guards but
            // never dropped. Retain it and retry only after the remaining floor.
            const retryAtMs = Math.max(Date.now(), res.retryAtMs ?? Date.now() + DEFAULT_RETRY_MS);
            queuePendingWakeReason({
              source: pendingWake.source,
              intent: pendingWake.intent,
              reason: pendingWake.reason ?? "retry",
              agentId: pendingWake.agentId,
              sessionKey: pendingWake.sessionKey,
              heartbeat: pendingWake.heartbeat,
              tasks: pendingWake.tasks,
              scheduledEveryMs: pendingWake.scheduledEveryMs,
              scheduledAnchorMs: pendingWake.scheduledAnchorMs,
              requestedAt: pendingWake.requestedAt,
              notBeforeMs: retryAtMs,
              guardRetry: true,
            });
            schedule(retryAtMs - Date.now());
          }
        }
      } catch {
        // Error is already logged by the heartbeat runner; schedule a retry.
        for (const pendingWake of pendingBatch) {
          queuePendingWakeReason({
            source: pendingWake.source,
            intent: pendingWake.intent,
            reason: pendingWake.reason ?? "retry",
            agentId: pendingWake.agentId,
            sessionKey: pendingWake.sessionKey,
            heartbeat: pendingWake.heartbeat,
            scheduledEveryMs: pendingWake.scheduledEveryMs,
            scheduledAnchorMs: pendingWake.scheduledAnchorMs,
            tasks: pendingWake.tasks,
            requestedAt: pendingWake.requestedAt,
            blockTargetUntilMs: Date.now() + DEFAULT_RETRY_MS,
          });
        }
        schedule(DEFAULT_RETRY_MS);
      } finally {
        running = false;
        if (pendingWakes.size > 0 || scheduled) {
          schedulePendingWakes(delay);
        }
      }
    })();
  }, delay);
  timer.unref?.();
}

function schedulePendingWakes(readyDelayMs: number) {
  const now = Date.now();
  let earliestNotBeforeMs = Number.POSITIVE_INFINITY;
  let hasReadyWake = false;
  for (const group of pendingWakes.values()) {
    if (group.blockedUntilMs !== undefined && group.blockedUntilMs > now) {
      earliestNotBeforeMs = Math.min(earliestNotBeforeMs, group.blockedUntilMs);
      continue;
    }
    for (const pending of [group.task, group.scheduled, group.event]) {
      if (!pending) {
        continue;
      }
      if (pending.notBeforeMs === undefined || pending.notBeforeMs <= now) {
        hasReadyWake = true;
      } else {
        earliestNotBeforeMs = Math.min(earliestNotBeforeMs, pending.notBeforeMs);
      }
    }
  }
  if (hasReadyWake) {
    schedule(readyDelayMs);
  } else if (Number.isFinite(earliestNotBeforeMs)) {
    schedule(earliestNotBeforeMs - now);
  }
}

function clearPendingWakeRetryState() {
  for (const group of pendingWakes.values()) {
    delete group.blockedUntilMs;
    for (const pending of [group.task, group.scheduled, group.event]) {
      if (!pending) {
        continue;
      }
      delete pending.notBeforeMs;
      delete pending.guardRetry;
    }
  }
}

/**
 * Register (or clear) the heartbeat wake handler.
 * Returns a disposer function that clears this specific registration.
 * Stale disposers (from previous registrations) are no-ops, preventing
 * a race where an old runner's cleanup clears a newer runner's handler.
 */
export function setHeartbeatWakeHandler(next: HeartbeatWakeHandler | null): () => void {
  handlerGeneration += 1;
  const generation = handlerGeneration;
  handler = next;
  if (next) {
    // New lifecycle starting (e.g. after SIGUSR1 in-process restart).
    // Clear any timer metadata from the previous lifecycle so stale retry
    // cooldowns do not delay a fresh handler.
    if (timer) {
      clearTimeout(timer);
    }
    timer = null;
    timerDueAt = null;
    // Reset module-level execution state that may be stale from interrupted
    // runs in the previous lifecycle. Without this, `running === true` from
    // an interrupted heartbeat blocks all future schedule() attempts, and
    // `scheduled === true` can cause spurious immediate re-runs.
    running = false;
    scheduled = false;
    clearPendingWakeRetryState();
  }
  if (handler && pendingWakes.size > 0) {
    schedulePendingWakes(DEFAULT_COALESCE_MS);
  }
  return () => {
    if (handlerGeneration !== generation) {
      return;
    }
    if (handler !== next) {
      return;
    }
    handlerGeneration += 1;
    handler = null;
  };
}

export function requestHeartbeat(opts: {
  source: HeartbeatWakeSource;
  intent: HeartbeatWakeIntent;
  reason?: string;
  coalesceMs?: number;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: HeartbeatWakeOverride;
  scheduledEveryMs?: number;
  scheduledAnchorMs?: number;
  tasks?: readonly HeartbeatScheduledTask[];
}) {
  queuePendingWakeReason({
    source: opts.source,
    intent: opts.intent,
    reason: opts.reason,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    heartbeat: opts.heartbeat,
    scheduledEveryMs: opts.scheduledEveryMs,
    scheduledAnchorMs: opts.scheduledAnchorMs,
    tasks: opts.tasks,
  });
  schedule(opts.coalesceMs ?? DEFAULT_COALESCE_MS);
}
