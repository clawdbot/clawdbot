import { normalizeHeartbeatWakeReason } from "./heartbeat-reason.js";
import type {
  HeartbeatScheduledTask,
  HeartbeatWakeIntent,
  HeartbeatWakeOverride,
  HeartbeatWakeSource,
} from "./heartbeat-wake-contracts.js";
import {
  activeHeartbeatWakeSettlements,
  type HeartbeatWakeSettlement,
} from "./heartbeat-wake-settlement.js";
import {
  normalizeHeartbeatWakeTarget,
  resolveHeartbeatWakeTargetKey,
} from "./heartbeat-wake-target.js";

export type PendingWakeReason = {
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
  parentRunId?: string;
  heartbeat?: HeartbeatWakeOverride;
  trustedContinuationRouting: boolean;
  scheduledEveryMs?: number;
  scheduledAnchorMs?: number;
  tasks?: HeartbeatScheduledTask[];
  /** Earliest instant at which this retained wake class may be dispatched. */
  notBeforeMs?: number;
  /** The wake was retained after a spacing/cooldown guard deferred its work. */
  guardRetry?: boolean;
  /** Cron callers waiting for this wake's terminal result. */
  settlements?: HeartbeatWakeSettlement[];
};

export type PendingWakeGroup = {
  task?: PendingWakeReason;
  scheduled?: PendingWakeReason;
  event?: PendingWakeReason;
  /** Busy/error backoff blocks every wake class for this target. */
  blockedUntilMs?: number;
};

export type ReadyWakeGroup = {
  targetKey: string;
  wakes: PendingWakeReason[];
};

const REASON_PRIORITY = {
  RETRY: 0,
  INTERVAL: 1,
  DEFAULT: 2,
  ACTION: 3,
} as const;

export function resolveWakePriority(params: {
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

export function normalizeWakeReason(reason?: string): string {
  return normalizeHeartbeatWakeReason(reason);
}

export function normalizeWakeTarget(value?: string): string | undefined {
  return normalizeHeartbeatWakeTarget(value);
}

export function getWakeCoalesceKey(params: {
  agentId?: string;
  sessionKey?: string;
  trustedContinuationRouting: boolean;
}) {
  const trustDomain = params.trustedContinuationRouting ? "trusted-continuation" : "default";
  return `${resolveHeartbeatWakeTargetKey(params)}::${trustDomain}`;
}

// The unscoped group is upstream's global flush barrier. Trust-domain separation
// splits that group in two, so both spellings must keep the barrier semantics or
// an unscoped immediate wake silently stops flushing coalesced targets.
export const UNSCOPED_WAKE_TARGET_KEYS = [
  getWakeCoalesceKey({ trustedContinuationRouting: false }),
  getWakeCoalesceKey({ trustedContinuationRouting: true }),
];

export function isUnscopedWakeTargetKey(targetKey: string): boolean {
  return UNSCOPED_WAKE_TARGET_KEYS.includes(targetKey);
}

export function mergePendingWakeReasons(
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
  const settlements = activeHeartbeatWakeSettlements(previous.settlements, next.settlements);
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
    ...(settlements.length ? { settlements } : {}),
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
