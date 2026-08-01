// Tracks heartbeat wake requests, busy skips, and retry timing.
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import { normalizeHeartbeatWakeReason } from "./heartbeat-reason.js";
import type {
  HeartbeatRunResult,
  HeartbeatScheduledTask,
  HeartbeatWakeHandler,
  HeartbeatWakeIntent,
  HeartbeatWakeOverride,
  HeartbeatWakeSource,
} from "./heartbeat-wake-contracts.js";
import {
  abortHeartbeatWakeGeneration,
  type ActiveHeartbeatWakeTarget,
  runAbortableHeartbeatWake,
} from "./heartbeat-wake-lifecycle.js";
import {
  GLOBAL_HEARTBEAT_WAKE_TARGET_KEY,
  isHeartbeatWakeAfterGlobalBarrier,
  isHeartbeatWakeTargetGroupReady,
  normalizeHeartbeatWakeTarget,
  resolveHeartbeatWakeTargetKey,
} from "./heartbeat-wake-target.js";

export { getHeartbeatWakeAbortSignal } from "./heartbeat-wake-lifecycle.js";
export type {
  HeartbeatRunResult,
  HeartbeatScheduledTask,
  HeartbeatWakeHandler,
  HeartbeatWakeIntent,
  HeartbeatWakeRequest,
  HeartbeatWakeSource,
} from "./heartbeat-wake-contracts.js";

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
  /** Stable enqueue order retained across coalescing, deferral, and lifecycle handoff. */
  enqueueSequence: number;
  /** First immediate-global request represented by this coalesced wake. */
  immediateBarrierSequence?: number;
  /** Earliest dispatch instant requested by the wake's coalescing window. */
  readyAtMs?: number;
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

type ReadyWakeGroup = {
  targetKey: string;
  wakes: PendingWakeReason[];
};

let handler: HeartbeatWakeHandler | null = null;
let handlerGeneration = 0;
// One bounded group per target owns every pending/retry class for that agent/session.
const pendingWakes = new Map<string, PendingWakeGroup>();
// Independent targets can run together; each target still owns one serial turn.
const activeWakeTargets = new Map<string, ActiveHeartbeatWakeTarget>();
let timer: NodeJS.Timeout | null = null;
let timerDueAt: number | null = null;
let wakeEnqueueSequence = 0;

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1_000;
// Heartbeat turns can start model/provider work; bound cross-target fan-out so
// one aligned monitor tick cannot exhaust gateway or provider capacity.
const MAX_CONCURRENT_HEARTBEAT_WAKE_TARGETS = 4;
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
  // Explicit wakes bypass a retained spacing guard, but busy backoff remains
  // target-owned in PendingWakeGroup.blockedUntilMs.
  const bypassGuardRetry =
    (preferred.intent === "manual" || preferred.intent === "immediate") &&
    preferred.guardRetry !== true &&
    (previous.guardRetry === true || next.guardRetry === true);
  const scheduledEveryMs = preferred.scheduledEveryMs ?? other.scheduledEveryMs;
  const scheduledAnchorMs = preferred.scheduledAnchorMs ?? other.scheduledAnchorMs;
  const immediateBarrierSequences = [
    previous.immediateBarrierSequence,
    next.immediateBarrierSequence,
  ].filter((value): value is number => value !== undefined);
  const readyAtMs = Math.min(
    previous.readyAtMs ?? previous.requestedAt,
    next.readyAtMs ?? next.requestedAt,
  );
  const merged: PendingWakeReason = {
    ...preferred,
    enqueueSequence: Math.min(previous.enqueueSequence, next.enqueueSequence),
    readyAtMs,
    ...(!bypassGuardRetry && (previous.notBeforeMs !== undefined || next.notBeforeMs !== undefined)
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
  if (!bypassGuardRetry && (previous.guardRetry || next.guardRetry)) {
    merged.guardRetry = true;
  } else {
    delete merged.guardRetry;
  }
  if (immediateBarrierSequences.length > 0) {
    merged.immediateBarrierSequence = Math.min(...immediateBarrierSequences);
  } else {
    delete merged.immediateBarrierSequence;
  }
  return merged;
}

function takePendingWakeBatch(maxGroups: number, now = Date.now()): ReadyWakeGroup[] {
  if (maxGroups <= 0) {
    return [];
  }
  const globalWakeGroup = pendingWakes.get(GLOBAL_HEARTBEAT_WAKE_TARGET_KEY);
  const globalImmediateWake = globalWakeGroup?.event;
  // An unscoped immediate wake is a global flush barrier. Preserve the task
  // registry contract while keeping spacing and busy guards authoritative.
  const flushPendingCoalescing =
    globalImmediateWake?.intent === "immediate" &&
    !activeWakeTargets.has(GLOBAL_HEARTBEAT_WAKE_TARGET_KEY) &&
    (globalWakeGroup?.blockedUntilMs === undefined || globalWakeGroup.blockedUntilMs <= now) &&
    (globalImmediateWake.readyAtMs === undefined || globalImmediateWake.readyAtMs <= now) &&
    (globalImmediateWake.notBeforeMs === undefined || globalImmediateWake.notBeforeMs <= now);
  const globalBarrierCutoffSequence =
    globalImmediateWake?.intent === "immediate"
      ? globalImmediateWake.immediateBarrierSequence
      : undefined;
  const globalBarrierReady = isHeartbeatWakeTargetGroupReady(globalWakeGroup, now);
  if (activeWakeTargets.has(GLOBAL_HEARTBEAT_WAKE_TARGET_KEY)) {
    return [];
  }
  // An unscoped wake can fan out across every configured heartbeat agent.
  // Never admit it beside a targeted turn. Immediate flushes first drain only
  // target work that predates the barrier; every other global wake takes the
  // barrier as soon as existing targeted turns have retired.
  if (globalBarrierReady && activeWakeTargets.size > 0) {
    return [];
  }
  const readyGroups: Array<{ targetKey: string; group: PendingWakeGroup }> = [];
  const pendingEntries = globalBarrierReady
    ? flushPendingCoalescing
      ? [...pendingWakes.entries()].toSorted(
          ([leftTarget], [rightTarget]) =>
            Number(leftTarget === GLOBAL_HEARTBEAT_WAKE_TARGET_KEY) -
            Number(rightTarget === GLOBAL_HEARTBEAT_WAKE_TARGET_KEY),
        )
      : [[GLOBAL_HEARTBEAT_WAKE_TARGET_KEY, globalWakeGroup as PendingWakeGroup] as const]
    : pendingWakes.entries();
  for (const [targetKey, group] of pendingEntries) {
    if (readyGroups.length >= maxGroups) {
      break;
    }
    if (
      activeWakeTargets.has(targetKey) ||
      (group.blockedUntilMs !== undefined && group.blockedUntilMs > now)
    ) {
      continue;
    }
    if (
      targetKey === GLOBAL_HEARTBEAT_WAKE_TARGET_KEY &&
      (activeWakeTargets.size > 0 || readyGroups.length > 0)
    ) {
      continue;
    }
    const ready: PendingWakeGroup = {};
    const remaining: PendingWakeGroup = {};
    for (const slot of ["task", "scheduled", "event"] as const) {
      const pending = group[slot];
      if (!pending) {
        continue;
      }
      const isPostBarrierTarget = isHeartbeatWakeAfterGlobalBarrier(
        targetKey,
        pending.enqueueSequence,
        globalBarrierCutoffSequence,
      );
      if (
        !isPostBarrierTarget &&
        (flushPendingCoalescing || pending.readyAtMs === undefined || pending.readyAtMs <= now) &&
        (pending.notBeforeMs === undefined || pending.notBeforeMs <= now)
      ) {
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
      readyGroups.push({ targetKey, group: ready });
    }
  }

  const batch: ReadyWakeGroup[] = [];
  for (const { targetKey, group } of readyGroups) {
    const wakes: PendingWakeReason[] = [];
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
        wakes.push(
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
        wakes.push(taskWake);
      }
    } else if (group.event) {
      wakes.push(
        group.scheduled ? mergePendingWakeReasons(group.scheduled, group.event) : group.event,
      );
    } else if (group.scheduled) {
      wakes.push(group.scheduled);
    }
    batch.push({ targetKey, wakes });
  }
  return batch;
}

function queuePendingWakeReason(params: {
  source: HeartbeatWakeSource;
  intent: HeartbeatWakeIntent;
  reason?: string;
  requestedAt?: number;
  enqueueSequence?: number;
  immediateBarrierSequence?: number;
  readyAtMs?: number;
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
  const enqueueSequence = params.enqueueSequence ?? ++wakeEnqueueSequence;
  const normalizedReason = normalizeWakeReason(params.reason);
  const normalizedAgentId = normalizeHeartbeatWakeTarget(params.agentId);
  const normalizedSessionKey = normalizeHeartbeatWakeTarget(params.sessionKey);
  const wakeTargetKey = resolveHeartbeatWakeTargetKey({
    agentId: normalizedAgentId,
    sessionKey: normalizedSessionKey,
  });
  const immediateBarrierSequence =
    params.immediateBarrierSequence ??
    (wakeTargetKey === GLOBAL_HEARTBEAT_WAKE_TARGET_KEY && params.intent === "immediate"
      ? enqueueSequence
      : undefined);
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
    enqueueSequence,
    ...(immediateBarrierSequence === undefined ? {} : { immediateBarrierSequence }),
    ...(params.readyAtMs === undefined ? {} : { readyAtMs: params.readyAtMs }),
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

function retryPendingWake(pendingWake: PendingWakeReason) {
  // A thrown or busy wake owns only its target; replaying the whole batch
  // duplicates completed reminders and stalls unrelated agents.
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
    enqueueSequence: pendingWake.enqueueSequence,
    immediateBarrierSequence: pendingWake.immediateBarrierSequence,
    blockTargetUntilMs: Date.now() + DEFAULT_RETRY_MS,
  });
  schedule(DEFAULT_RETRY_MS);
}

function handOffPendingWakeBatch(pendingBatch: PendingWakeReason[], startIndex: number) {
  // A replacement handler inherits unfinished work, never the old handler's
  // completed targets, busy backoff, or spacing guard.
  for (const pendingWake of pendingBatch.slice(startIndex)) {
    queuePendingWakeReason(pendingWake);
  }
  if (handler && startIndex < pendingBatch.length) {
    schedulePendingWakes(DEFAULT_COALESCE_MS);
  }
}

async function dispatchPendingWakeGroup(params: {
  active: HeartbeatWakeHandler;
  generation: number;
  targetKey: string;
  wakes: PendingWakeReason[];
  abortSignal: AbortSignal;
}): Promise<void> {
  const { active, generation, targetKey, wakes, abortSignal } = params;
  try {
    for (const [wakeIndex, pendingWake] of wakes.entries()) {
      if (handlerGeneration !== generation) {
        handOffPendingWakeBatch(wakes, wakeIndex);
        return;
      }
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
      let result: HeartbeatRunResult;
      try {
        // Admission spans the entire target turn so gateway drain can observe it.
        result = await runWithGatewayIndependentRootWorkAdmission(async () =>
          runAbortableHeartbeatWake(active, wakeOpts, abortSignal),
        );
      } catch {
        if (handlerGeneration !== generation) {
          handOffPendingWakeBatch(wakes, wakeIndex);
          return;
        }
        retryPendingWake(pendingWake);
        continue;
      }
      if (handlerGeneration !== generation) {
        const retainWake =
          result.status === "skipped" &&
          (isRetryableHeartbeatBusySkipReason(result.reason) ||
            (RETRYABLE_GUARD_SKIP_REASONS.has(result.reason) &&
              (pendingWake.tasks?.length ||
                pendingWake.intent === "task" ||
                pendingWake.intent === "event" ||
                pendingWake.intent === "immediate")));
        handOffPendingWakeBatch(wakes, wakeIndex + (retainWake ? 0 : 1));
        return;
      }
      if (result.status === "skipped" && isRetryableHeartbeatBusySkipReason(result.reason)) {
        retryPendingWake(pendingWake);
      } else if (
        result.status === "skipped" &&
        RETRYABLE_GUARD_SKIP_REASONS.has(result.reason) &&
        (pendingWake.tasks?.length ||
          pendingWake.intent === "task" ||
          pendingWake.intent === "event" ||
          pendingWake.intent === "immediate")
      ) {
        // Retain real task/event work until its spacing guard allows a retry.
        const retryAtMs = Math.max(Date.now(), result.retryAtMs ?? Date.now() + DEFAULT_RETRY_MS);
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
          enqueueSequence: pendingWake.enqueueSequence,
          immediateBarrierSequence: pendingWake.immediateBarrierSequence,
          notBeforeMs: retryAtMs,
          guardRetry: true,
        });
        schedule(retryAtMs - Date.now());
      }
    }
  } finally {
    // A replaced lifecycle may already own this target; never unlock it.
    if (activeWakeTargets.get(targetKey)?.generation === generation) {
      activeWakeTargets.delete(targetKey);
      if (pendingWakes.size > 0) {
        // Re-evaluate each target's own deadline: a later timer for another
        // target must never postpone this target's already-ready wake.
        schedulePendingWakes(0);
      }
    }
  }
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
      const active = handler;
      if (!active) {
        return;
      }
      const activeGeneration = handlerGeneration;
      const availableTargetSlots = MAX_CONCURRENT_HEARTBEAT_WAKE_TARGETS - activeWakeTargets.size;
      for (const group of takePendingWakeBatch(availableTargetSlots)) {
        const abortController = new AbortController();
        activeWakeTargets.set(group.targetKey, {
          generation: activeGeneration,
          abortController,
        });
        void dispatchPendingWakeGroup({
          active,
          generation: activeGeneration,
          targetKey: group.targetKey,
          wakes: group.wakes,
          abortSignal: abortController.signal,
        });
      }
      if (pendingWakes.size > 0) {
        // A sooner request can consume a deferred retry timer; restore the
        // earliest eligible target without spinning on active target groups.
        schedulePendingWakes(delay);
      }
    })();
  }, delay);
  timer.unref?.();
}

function schedulePendingWakes(readyDelayMs: number) {
  if (activeWakeTargets.size >= MAX_CONCURRENT_HEARTBEAT_WAKE_TARGETS) {
    // A completing target re-arms the earliest pending wake; scheduling now
    // would spin zero-delay timers while every provider slot remains busy.
    return;
  }
  const now = Date.now();
  if (
    activeWakeTargets.has(GLOBAL_HEARTBEAT_WAKE_TARGET_KEY) ||
    (activeWakeTargets.size > 0 &&
      isHeartbeatWakeTargetGroupReady(pendingWakes.get(GLOBAL_HEARTBEAT_WAKE_TARGET_KEY), now))
  ) {
    // The active side of a global barrier re-arms pending work when it exits.
    // Avoid zero-delay timer churn while the other side is still draining.
    return;
  }
  const pendingGlobalImmediateWake = pendingWakes.get(GLOBAL_HEARTBEAT_WAKE_TARGET_KEY)?.event;
  const globalBarrierCutoffSequence =
    pendingGlobalImmediateWake?.intent === "immediate"
      ? pendingGlobalImmediateWake.immediateBarrierSequence
      : undefined;
  let earliestNotBeforeMs = Number.POSITIVE_INFINITY;
  let hasReadyWake = false;
  for (const [targetKey, group] of pendingWakes) {
    if (activeWakeTargets.has(targetKey)) {
      continue;
    }
    const groupWakes = [group.task, group.scheduled, group.event];
    if (
      groupWakes.every(
        (pending) =>
          !pending ||
          isHeartbeatWakeAfterGlobalBarrier(
            targetKey,
            pending.enqueueSequence,
            globalBarrierCutoffSequence,
          ),
      )
    ) {
      continue;
    }
    if (group.blockedUntilMs !== undefined && group.blockedUntilMs > now) {
      earliestNotBeforeMs = Math.min(earliestNotBeforeMs, group.blockedUntilMs);
      continue;
    }
    for (const pending of groupWakes) {
      if (
        !pending ||
        isHeartbeatWakeAfterGlobalBarrier(
          targetKey,
          pending.enqueueSequence,
          globalBarrierCutoffSequence,
        )
      ) {
        continue;
      }
      const nextReadyAtMs = Math.max(pending.readyAtMs ?? 0, pending.notBeforeMs ?? 0);
      if (nextReadyAtMs <= now) {
        hasReadyWake = true;
      } else {
        earliestNotBeforeMs = Math.min(earliestNotBeforeMs, nextReadyAtMs);
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
  const previousGeneration = handlerGeneration;
  handlerGeneration += 1;
  const generation = handlerGeneration;
  handler = next;
  // Registration changes retire only the lifecycle they replaced. A stale
  // disposer must never cancel active work owned by a newer handler.
  abortHeartbeatWakeGeneration(activeWakeTargets.values(), previousGeneration);
  if (next) {
    // New lifecycle starting (e.g. after SIGUSR1 in-process restart).
    // Clear any timer metadata from the previous lifecycle so stale retry
    // cooldowns do not delay a fresh handler.
    if (timer) {
      clearTimeout(timer);
    }
    timer = null;
    timerDueAt = null;
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
    abortHeartbeatWakeGeneration(activeWakeTargets.values(), generation);
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
  const requestedAt = Date.now();
  const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
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
    requestedAt,
    readyAtMs: requestedAt + resolveTimerTimeoutMs(coalesceMs, DEFAULT_COALESCE_MS, 0),
  });
  schedule(coalesceMs);
}
