import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
// Tracks heartbeat wake requests, busy skips, and retry timing.
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { normalizeHeartbeatWakeReason } from "./heartbeat-reason.js";
import type {
  HeartbeatRunResult,
  HeartbeatScheduledTask,
  HeartbeatWakeHandler,
  HeartbeatWakeIntent,
  HeartbeatWakeOverride,
  HeartbeatWakeRequest,
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
export const HEARTBEAT_SKIP_NO_PENDING_EVENT = "no-pending-event";
export const HEARTBEAT_SKIP_PREEMPTED = "preempted";
export const HEARTBEAT_SKIP_CHANNEL_NOT_READY = "channel-not-ready";
const RETRYABLE_HEARTBEAT_SKIP_REASONS = new Set([
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  HEARTBEAT_SKIP_PREEMPTED,
  HEARTBEAT_SKIP_CHANNEL_NOT_READY,
]);
const RETRYABLE_GUARD_SKIP_REASONS = new Set(["not-due", "min-spacing", "flood"]);

export function isRetryableHeartbeatSkipReason(reason: string): boolean {
  return RETRYABLE_HEARTBEAT_SKIP_REASONS.has(reason);
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
  tasks?: HeartbeatScheduledTask[];
  /** Earliest instant at which this retained wake class may be dispatched. */
  notBeforeMs?: number;
  /** The wake was deferred with real work that must survive later retries. */
  retainedWork?: boolean;
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
export const HEARTBEAT_IDLE_RETRY_GRACE_MS = 60_000;
// Heartbeat turns can start model/provider work; bound cross-target fan-out so
// one aligned monitor tick cannot exhaust gateway or provider capacity.
const MAX_CONCURRENT_HEARTBEAT_WAKE_TARGETS = 4;
const wakeLog = createSubsystemLogger("heartbeat/wake");
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
  // Explicit wakes bypass deferred background work, but busy backoff remains
  // target-owned in PendingWakeGroup.blockedUntilMs.
  const bypassRetainedWork =
    (preferred.intent === "manual" || preferred.intent === "immediate") &&
    preferred.retainedWork !== true &&
    (previous.retainedWork === true || next.retainedWork === true);
  const scheduledEveryMs = preferred.scheduledEveryMs ?? other.scheduledEveryMs;
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
    ...(!bypassRetainedWork &&
    (previous.notBeforeMs !== undefined || next.notBeforeMs !== undefined)
      ? {
          requestedAt: Math.min(previous.requestedAt, next.requestedAt),
          notBeforeMs: Math.max(previous.notBeforeMs ?? 0, next.notBeforeMs ?? 0),
        }
      : {}),
    ...((preferred.heartbeat ?? other.heartbeat)
      ? { heartbeat: preferred.heartbeat ?? other.heartbeat }
      : {}),
    ...(scheduledEveryMs !== undefined ? { scheduledEveryMs } : {}),
    ...(mergedTasks.length ? { tasks: mergedTasks } : {}),
  };
  if (!bypassRetainedWork && (previous.retainedWork || next.retainedWork)) {
    merged.retainedWork = true;
  } else {
    delete merged.retainedWork;
  }
  if (immediateBarrierSequences.length > 0) {
    merged.immediateBarrierSequence = Math.min(...immediateBarrierSequences);
  } else {
    delete merged.immediateBarrierSequence;
  }
  return merged;
}

function* pendingTargetsBeforeGlobal(globalWakeGroup: PendingWakeGroup) {
  // Selection only updates/deletes the current target, with no callbacks or
  // awaits. Keep target insertion order without materializing the whole queue.
  for (const entry of pendingWakes) {
    if (entry[0] !== GLOBAL_HEARTBEAT_WAKE_TARGET_KEY) {
      yield entry;
    }
  }
  yield [GLOBAL_HEARTBEAT_WAKE_TARGET_KEY, globalWakeGroup] as const;
}

function takePendingWakeBatch(maxGroups: number, now = performance.now()): ReadyWakeGroup[] {
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
      ? pendingTargetsBeforeGlobal(
          // SAFETY: Readiness rejects an absent global group.
          globalWakeGroup as PendingWakeGroup,
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
            if (left.retainedWork !== right.retainedWork) {
              return left.retainedWork ? -1 : 1;
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
  tasks?: readonly HeartbeatScheduledTask[];
  notBeforeMs?: number;
  blockTargetUntilMs?: number;
  retainedWork?: boolean;
}) {
  const requestedAt = params.requestedAt ?? performance.now();
  const enqueueSequence = params.enqueueSequence ?? ++wakeEnqueueSequence;
  const normalizedReason = normalizeHeartbeatWakeReason(params.reason);
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
    ...(params.tasks?.length ? { tasks: [...params.tasks] } : {}),
    ...(params.notBeforeMs === undefined ? {} : { notBeforeMs: params.notBeforeMs }),
    ...(params.retainedWork ? { retainedWork: true } : {}),
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

function resolveHeartbeatRetrySchedule(
  pendingWake: Pick<HeartbeatWakeRequest, "intent">,
  result: Extract<HeartbeatRunResult, { status: "skipped" }>,
): { delayMs: number; deferWakeOnly: boolean } {
  const now = Date.now();
  const deferWakeOnly =
    result.reason === HEARTBEAT_SKIP_PREEMPTED ||
    result.reason === HEARTBEAT_SKIP_CHANNEL_NOT_READY ||
    (result.reason === HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT &&
      (pendingWake.intent === "scheduled" || pendingWake.intent === "task"));
  return {
    delayMs:
      result.retryAtMs !== undefined
        ? Math.max(0, result.retryAtMs - now)
        : deferWakeOnly
          ? HEARTBEAT_IDLE_RETRY_GRACE_MS
          : DEFAULT_RETRY_MS,
    deferWakeOnly,
  };
}

function retryPendingWake(
  pendingWake: Parameters<typeof queuePendingWakeReason>[0],
  retrySchedule: { delayMs: number; deferWakeOnly: boolean } = {
    delayMs: DEFAULT_RETRY_MS,
    deferWakeOnly: false,
  },
) {
  // A thrown or busy wake owns only its target; replaying the whole batch
  // duplicates completed reminders and stalls unrelated agents.
  const retryAtMs = performance.now() + retrySchedule.delayMs;
  queuePendingWakeReason({
    source: pendingWake.source,
    intent: pendingWake.intent,
    reason: pendingWake.reason ?? "retry",
    agentId: pendingWake.agentId,
    sessionKey: pendingWake.sessionKey,
    heartbeat: pendingWake.heartbeat,
    scheduledEveryMs: pendingWake.scheduledEveryMs,
    tasks: pendingWake.tasks,
    requestedAt: pendingWake.requestedAt,
    enqueueSequence: pendingWake.enqueueSequence,
    immediateBarrierSequence: pendingWake.immediateBarrierSequence,
    ...(retrySchedule.deferWakeOnly
      ? { notBeforeMs: retryAtMs, retainedWork: true }
      : { blockTargetUntilMs: retryAtMs, retainedWork: pendingWake.retainedWork }),
  });
  schedule(retrySchedule.delayMs);
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
        ...(pendingWake.tasks ? { tasks: pendingWake.tasks } : {}),
        ...(pendingWake.retainedWork ? { retainedWork: true } : {}),
      };
      let result: HeartbeatRunResult;
      try {
        // Admission spans the entire target turn so gateway drain can observe it.
        result = await runWithGatewayIndependentRootWorkAdmission(async () =>
          runAbortableHeartbeatWake(active, wakeOpts, abortSignal),
        );
        wakeLog.debug(
          `completed: source=${pendingWake.source} intent=${pendingWake.intent} ` +
            `status=${result.status} reason=${"reason" in result ? result.reason : "ran"}`,
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
          (isRetryableHeartbeatSkipReason(result.reason) ||
            (RETRYABLE_GUARD_SKIP_REASONS.has(result.reason) &&
              (pendingWake.tasks?.length ||
                pendingWake.intent === "task" ||
                pendingWake.intent === "event" ||
                pendingWake.intent === "immediate")));
        handOffPendingWakeBatch(wakes, wakeIndex + (retainWake ? 0 : 1));
        return;
      }
      if (result.status === "skipped" && isRetryableHeartbeatSkipReason(result.reason)) {
        retryPendingWake(pendingWake, resolveHeartbeatRetrySchedule(pendingWake, result));
      } else if (
        result.status === "skipped" &&
        RETRYABLE_GUARD_SKIP_REASONS.has(result.reason) &&
        (pendingWake.tasks?.length ||
          pendingWake.intent === "task" ||
          pendingWake.intent === "event" ||
          pendingWake.intent === "immediate")
      ) {
        // Retain real task/event work until its spacing guard allows a retry.
        const { delayMs } = resolveHeartbeatRetrySchedule(pendingWake, result);
        retryPendingWake(pendingWake, { delayMs, deferWakeOnly: true });
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
  const dueAt = performance.now() + delay;
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
  const now = performance.now();
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
        schedule(readyDelayMs);
        return;
      }
      earliestNotBeforeMs = Math.min(earliestNotBeforeMs, nextReadyAtMs);
    }
  }
  if (Number.isFinite(earliestNotBeforeMs)) {
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
      delete pending.retainedWork;
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
  tasks?: readonly HeartbeatScheduledTask[];
}) {
  const requestedAt = performance.now();
  const { coalesceMs: requestedCoalesceMs, ...wake } = opts;
  const coalesceMs = requestedCoalesceMs ?? DEFAULT_COALESCE_MS;
  // Wake timers outlive the attempt that requested them. Do not let their
  // callback chain inherit that attempt's transcript writer: a later wake for
  // the same session must acquire its own writer lifecycle.
  runWithoutOwnedSessionTranscriptWrites(() => {
    queuePendingWakeReason({
      ...wake,
      requestedAt,
      readyAtMs: requestedAt + resolveTimerTimeoutMs(coalesceMs, DEFAULT_COALESCE_MS, 0),
    });
    schedule(coalesceMs);
  });
}

/** Transfers a direct attempt to the wake owner's existing retry lifecycle. */
export function requestHeartbeatRetry(
  wake: HeartbeatWakeRequest,
  result: Extract<HeartbeatRunResult, { status: "skipped" }>,
) {
  runWithoutOwnedSessionTranscriptWrites(() => {
    retryPendingWake(wake, resolveHeartbeatRetrySchedule(wake, result));
  });
}
