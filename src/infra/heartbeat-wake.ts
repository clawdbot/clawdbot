import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
// Tracks heartbeat wake requests, busy skips, and retry timing.
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import {
  getWakeCoalesceKey,
  isUnscopedWakeTargetKey,
  mergePendingWakeReasons,
  normalizeWakeReason,
  normalizeWakeTarget,
  resolveWakePriority,
  UNSCOPED_WAKE_TARGET_KEYS,
  type PendingWakeGroup,
  type PendingWakeReason,
  type ReadyWakeGroup,
} from "./heartbeat-wake-coalescing.js";
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
  isHeartbeatWakeAfterGlobalBarrier,
  isHeartbeatWakeTargetGroupReady,
} from "./heartbeat-wake-target.js";

export {
  getActiveHeartbeatWakeContext,
  getHeartbeatWakeAbortSignal,
} from "./heartbeat-wake-lifecycle.js";
export const HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT = "requests-in-flight";
export const HEARTBEAT_SKIP_CRON_IN_PROGRESS = "cron-in-progress";
export const HEARTBEAT_SKIP_NO_PENDING_EVENT = "no-pending-event";
export const HEARTBEAT_SKIP_PREEMPTED = "preempted";
const RETRYABLE_HEARTBEAT_SKIP_REASONS = new Set([
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  HEARTBEAT_SKIP_PREEMPTED,
]);
const RETRYABLE_GUARD_SKIP_REASONS = new Set(["not-due", "min-spacing", "flood"]);

export function isRetryableHeartbeatSkipReason(reason: string): boolean {
  return RETRYABLE_HEARTBEAT_SKIP_REASONS.has(reason);
}

// Continuation dispatch shares this retry gate; preemption now joins the same
// retained-work contract as the previously busy-only reasons.
export const isRetryableHeartbeatBusySkipReason = isRetryableHeartbeatSkipReason;

const TRUSTED_CONTINUATION_ROUTING_MARKER = Symbol("trustedContinuationRouting");

type TrustedContinuationRoutingCarrier = {
  [TRUSTED_CONTINUATION_ROUTING_MARKER]?: true;
};

function markTrustedContinuationRoutingCarrier<T extends object>(request: T): T {
  Object.defineProperty(request, TRUSTED_CONTINUATION_ROUTING_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return request;
}

export function markTrustedContinuationHeartbeatWake<T extends object>(request: T): T {
  return markTrustedContinuationRoutingCarrier(request);
}

export function hasTrustedContinuationHeartbeatWake(
  request: unknown,
): request is TrustedContinuationRoutingCarrier {
  return Boolean(
    request &&
    typeof request === "object" &&
    (request as TrustedContinuationRoutingCarrier)[TRUSTED_CONTINUATION_ROUTING_MARKER] === true,
  );
}

let heartbeatsEnabled = true;

export function setHeartbeatsEnabled(enabled: boolean) {
  heartbeatsEnabled = enabled;
}

export function areHeartbeatsEnabled(): boolean {
  return heartbeatsEnabled;
}

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

/**
 * Trust-domain separation splits upstream's single unscoped group in two, so the
 * bare `"::"` comparison inside the upstream helper no longer identifies a global
 * wake. Narrow on the fork's unscoped key set first, then defer to upstream.
 */
function isAfterGlobalWakeBarrier(
  targetKey: string,
  enqueueSequence: number,
  barrierSequence: number | undefined,
): boolean {
  if (isUnscopedWakeTargetKey(targetKey)) {
    return false;
  }
  return isHeartbeatWakeAfterGlobalBarrier(targetKey, enqueueSequence, barrierSequence);
}

function takePendingWakeBatch(maxGroups: number, now = Date.now()): ReadyWakeGroup[] {
  if (maxGroups <= 0) {
    return [];
  }
  if (UNSCOPED_WAKE_TARGET_KEYS.some((targetKey) => activeWakeTargets.has(targetKey))) {
    return [];
  }
  // An unscoped immediate wake is a global flush barrier. Preserve the task
  // registry contract while keeping spacing and busy guards authoritative.
  // Both trust-domain spellings of the unscoped group own that barrier.
  const flushPendingCoalescing = UNSCOPED_WAKE_TARGET_KEYS.some((targetKey) => {
    const group = pendingWakes.get(targetKey);
    const immediateWake = group?.event;
    return (
      immediateWake?.intent === "immediate" &&
      (group?.blockedUntilMs === undefined || group.blockedUntilMs <= now) &&
      (immediateWake.readyAtMs === undefined || immediateWake.readyAtMs <= now) &&
      (immediateWake.notBeforeMs === undefined || immediateWake.notBeforeMs <= now)
    );
  });
  const barrierCutoffSequences = UNSCOPED_WAKE_TARGET_KEYS.flatMap((targetKey) => {
    const immediateWake = pendingWakes.get(targetKey)?.event;
    const sequence =
      immediateWake?.intent === "immediate" ? immediateWake.immediateBarrierSequence : undefined;
    return sequence === undefined ? [] : [sequence];
  });
  const globalBarrierCutoffSequence =
    barrierCutoffSequences.length > 0 ? Math.min(...barrierCutoffSequences) : undefined;
  const globalBarrierReady = UNSCOPED_WAKE_TARGET_KEYS.some((targetKey) =>
    isHeartbeatWakeTargetGroupReady(pendingWakes.get(targetKey), now),
  );
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
            Number(isUnscopedWakeTargetKey(leftTarget)) -
            Number(isUnscopedWakeTargetKey(rightTarget)),
        )
      : UNSCOPED_WAKE_TARGET_KEYS.flatMap((targetKey) => {
          const group = pendingWakes.get(targetKey);
          return group ? [[targetKey, group] as const] : [];
        })
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
      isUnscopedWakeTargetKey(targetKey) &&
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
      const isPostBarrierTarget = isAfterGlobalWakeBarrier(
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
  parentRunId?: string;
  heartbeat?: HeartbeatWakeOverride;
  trustedContinuationRouting?: boolean;
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
  const normalizedAgentId = normalizeWakeTarget(params.agentId);
  const normalizedSessionKey = normalizeWakeTarget(params.sessionKey);
  const normalizedParentRunId = normalizeWakeTarget(params.parentRunId);
  const trustedContinuationRouting = params.trustedContinuationRouting === true;
  const wakeTargetKey = getWakeCoalesceKey({
    agentId: normalizedAgentId,
    sessionKey: normalizedSessionKey,
    trustedContinuationRouting,
  });
  const immediateBarrierSequence =
    params.immediateBarrierSequence ??
    (isUnscopedWakeTargetKey(wakeTargetKey) && params.intent === "immediate"
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
    ...(normalizedParentRunId ? { parentRunId: normalizedParentRunId } : {}),
    heartbeat: params.heartbeat,
    trustedContinuationRouting,
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

function resolveHeartbeatRetrySchedule(
  pendingWake: PendingWakeReason,
  result: Extract<HeartbeatRunResult, { status: "skipped" }>,
): { delayMs: number; deferWakeOnly: boolean } {
  const now = Date.now();
  const deferWakeOnly =
    result.reason === HEARTBEAT_SKIP_PREEMPTED ||
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
  pendingWake: PendingWakeReason,
  retrySchedule: { delayMs: number; deferWakeOnly: boolean } = {
    delayMs: DEFAULT_RETRY_MS,
    deferWakeOnly: false,
  },
) {
  // A thrown or busy wake owns only its target; replaying the whole batch
  // duplicates completed reminders and stalls unrelated agents.
  const retryAtMs = Date.now() + retrySchedule.delayMs;
  queuePendingWakeReason({
    source: pendingWake.source,
    intent: pendingWake.intent,
    reason: pendingWake.reason ?? "retry",
    agentId: pendingWake.agentId,
    sessionKey: pendingWake.sessionKey,
    parentRunId: pendingWake.parentRunId,
    heartbeat: pendingWake.heartbeat,
    trustedContinuationRouting: pendingWake.trustedContinuationRouting,
    scheduledEveryMs: pendingWake.scheduledEveryMs,
    scheduledAnchorMs: pendingWake.scheduledAnchorMs,
    tasks: pendingWake.tasks,
    requestedAt: pendingWake.requestedAt,
    enqueueSequence: pendingWake.enqueueSequence,
    immediateBarrierSequence: pendingWake.immediateBarrierSequence,
    ...(retrySchedule.deferWakeOnly
      ? { notBeforeMs: retryAtMs, guardRetry: true }
      : { blockTargetUntilMs: retryAtMs, guardRetry: pendingWake.guardRetry }),
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
        ...(pendingWake.parentRunId ? { parentRunId: pendingWake.parentRunId } : {}),
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
      if (pendingWake.trustedContinuationRouting) {
        markTrustedContinuationRoutingCarrier(wakeOpts);
      }
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
        const retryAtMs = Math.max(Date.now(), result.retryAtMs ?? Date.now() + DEFAULT_RETRY_MS);
        queuePendingWakeReason({
          source: pendingWake.source,
          intent: pendingWake.intent,
          reason: pendingWake.reason ?? "retry",
          agentId: pendingWake.agentId,
          sessionKey: pendingWake.sessionKey,
          parentRunId: pendingWake.parentRunId,
          heartbeat: pendingWake.heartbeat,
          trustedContinuationRouting: pendingWake.trustedContinuationRouting,
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
    UNSCOPED_WAKE_TARGET_KEYS.some((targetKey) => activeWakeTargets.has(targetKey)) ||
    (activeWakeTargets.size > 0 &&
      UNSCOPED_WAKE_TARGET_KEYS.some((targetKey) =>
        isHeartbeatWakeTargetGroupReady(pendingWakes.get(targetKey), now),
      ))
  ) {
    // The active side of a global barrier re-arms pending work when it exits.
    // Avoid zero-delay timer churn while the other side is still draining.
    return;
  }
  const barrierCutoffSequences = UNSCOPED_WAKE_TARGET_KEYS.flatMap((targetKey) => {
    const pendingImmediateWake = pendingWakes.get(targetKey)?.event;
    const sequence =
      pendingImmediateWake?.intent === "immediate"
        ? pendingImmediateWake.immediateBarrierSequence
        : undefined;
    return sequence === undefined ? [] : [sequence];
  });
  const globalBarrierCutoffSequence =
    barrierCutoffSequences.length > 0 ? Math.min(...barrierCutoffSequences) : undefined;
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
          isAfterGlobalWakeBarrier(targetKey, pending.enqueueSequence, globalBarrierCutoffSequence),
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
        isAfterGlobalWakeBarrier(targetKey, pending.enqueueSequence, globalBarrierCutoffSequence)
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

export function requestHeartbeatRaw(opts: {
  source: HeartbeatWakeSource;
  intent: HeartbeatWakeIntent;
  reason?: string;
  coalesceMs?: number;
  agentId?: string;
  sessionKey?: string;
  parentRunId?: string;
  heartbeat?: HeartbeatWakeOverride;
  scheduledEveryMs?: number;
  scheduledAnchorMs?: number;
  tasks?: readonly HeartbeatScheduledTask[];
}) {
  const trustedContinuationRouting = hasTrustedContinuationHeartbeatWake(opts);
  const requestedAt = Date.now();
  const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
  queuePendingWakeReason({
    source: opts.source,
    intent: opts.intent,
    reason: opts.reason,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    parentRunId: opts.parentRunId,
    heartbeat: opts.heartbeat,
    trustedContinuationRouting,
    scheduledEveryMs: opts.scheduledEveryMs,
    scheduledAnchorMs: opts.scheduledAnchorMs,
    tasks: opts.tasks,
    requestedAt,
    readyAtMs: requestedAt + resolveTimerTimeoutMs(coalesceMs, DEFAULT_COALESCE_MS, 0),
  });
  schedule(coalesceMs);
}

export function requestHeartbeatNow(opts?: {
  source?: HeartbeatWakeSource;
  intent?: HeartbeatWakeIntent;
  reason?: string;
  coalesceMs?: number;
  agentId?: string;
  sessionKey?: string;
  parentRunId?: string;
  heartbeat?: HeartbeatWakeOverride;
}) {
  const request = {
    source: opts?.source ?? "other",
    intent: opts?.intent ?? "immediate",
    reason: opts?.reason,
    coalesceMs: opts?.coalesceMs,
    agentId: opts?.agentId,
    sessionKey: opts?.sessionKey,
    parentRunId: opts?.parentRunId,
    heartbeat: opts?.heartbeat,
  } satisfies Parameters<typeof requestHeartbeatRaw>[0];
  if (opts && hasTrustedContinuationHeartbeatWake(opts)) {
    markTrustedContinuationRoutingCarrier(request);
  }
  requestHeartbeatRaw(request);
}

export function resetHeartbeatWakeStateForTests() {
  if (timer) {
    clearTimeout(timer);
  }
  timer = null;
  timerDueAt = null;
  pendingWakes.clear();
  for (const target of activeWakeTargets.values()) {
    target.abortController.abort();
  }
  activeWakeTargets.clear();
  wakeEnqueueSequence = 0;
  handlerGeneration += 1;
  handler = null;
}
