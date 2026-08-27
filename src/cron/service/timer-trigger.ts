import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { CronConfig } from "../../config/types.cron.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { type CronRetryOn, resolveCronExecutionRetryHint } from "../retry-hint.js";
import { createCronStreamSourceIdentity } from "../stream-schedule.js";
import type {
  CronJob,
  CronDeliveryTrace,
  CronResolvedDeliveryState,
  CronRunErrorClassification,
  CronRunStatus,
} from "../types.js";
import { autoDisableCronJob } from "./auto-disable.js";
import {
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  errorBackoffMs,
  isJobEnabled,
} from "./jobs-scheduling.js";
import type {
  CronServiceState,
  CronSystemEventEnqueueResult,
  DeferredCronNotifications,
} from "./state.js";
import type { CronTriggerEvalOutcome } from "./timer-execution-timeout.js";
import { HEARTBEAT_SKIP_DISABLED } from "./timer-execution-timeout.js";

/** Default max retries for cron jobs on transient errors (#24355). */
const DEFAULT_MAX_TRANSIENT_RETRIES = 3;

type TransientCronRetryDecision = {
  retryable: boolean;
  consecutiveErrors: number;
  retryCategory?: CronRetryOn;
  backoffMs?: number;
  reason: "transient retry" | "max retries exhausted" | "permanent error";
};

type DisabledHeartbeatOneShotRetryDecision = {
  retryable: boolean;
  consecutiveSkipped: number;
  backoffMs?: number;
  reason: "disabled heartbeat retry" | "max retries exhausted";
};

type QueuedSystemEventHandle = {
  accepted: boolean;
  remove?: () => boolean | void;
};

/** Rejects outcome-generated schedule timestamps before they can persist or arm a timer. */
export function resolveNextRunAtMsOrDisable(params: {
  state: CronServiceState;
  job: CronJob;
  candidate: unknown;
  deferredNotifications?: DeferredCronNotifications;
}): number | undefined {
  const nextRunAtMs = asDateTimestampMs(params.candidate);
  if (nextRunAtMs !== undefined && nextRunAtMs > 0) {
    return nextRunAtMs;
  }
  autoDisableCronJob({
    state: params.state,
    job: params.job,
    reason: "schedule-errors",
    atMs: params.state.deps.nowMs(),
    consecutiveErrors: 1,
    deferredNotifications: params.deferredNotifications,
  });
  return undefined;
}

/** Persists non-busy trigger evaluation state without touching payload-run history. */
export function applyTriggerEvaluationState(
  job: CronJob,
  triggerEval: CronTriggerEvalOutcome,
  evaluatedAtMs: number,
): void {
  if (triggerEval.busy) {
    return;
  }
  job.state.lastTriggerEvalAtMs = evaluatedAtMs;
  job.state.triggerEvalCount = (job.state.triggerEvalCount ?? 0) + 1;
  if (triggerEval.stateChanged) {
    job.state.triggerState = triggerEval.state;
  }
  if (triggerEval.fired) {
    job.state.lastTriggerFireAtMs = evaluatedAtMs;
  }
}

/** Persists fired/error trigger metadata and disarms successful once triggers. */
export function applyTriggerRunResult(
  job: CronJob,
  result: { status: CronRunStatus; endedAt: number; triggerEval?: CronTriggerEvalOutcome },
  opts?: { scheduleOwnership?: "current" | "stale"; triggerOwnership?: "current" | "stale" },
): void {
  if (!result.triggerEval || opts?.triggerOwnership === "stale") {
    return;
  }
  // Failed payloads keep the old state so the next evaluation re-detects the event.
  const persistedEval =
    result.status === "ok"
      ? result.triggerEval
      : { ...result.triggerEval, stateChanged: false, state: undefined };
  applyTriggerEvaluationState(job, persistedEval, result.endedAt);
  if (
    opts?.scheduleOwnership !== "stale" &&
    result.triggerEval.fired &&
    job.trigger?.once === true &&
    result.status === "ok"
  ) {
    if (job.schedule.kind === "stream") {
      job.state.streamSourceIdentity = createCronStreamSourceIdentity();
    }
    job.enabled = false;
    job.state.nextRunAtMs = undefined;
  }
}

export function resolveCronNextRunWithLowerBound(params: {
  state: CronServiceState;
  job: CronJob;
  naturalNext: number | undefined;
  lowerBoundMs: number;
  deferredNotifications?: DeferredCronNotifications;
}): number | undefined {
  if (params.naturalNext === undefined) {
    params.state.deps.log.warn(
      {
        jobId: params.job.id,
        jobName: params.job.name,
      },
      "cron: next run unresolved; clearing schedule to avoid a refire loop",
    );
    return undefined;
  }
  return resolveNextRunAtMsOrDisable({
    state: params.state,
    job: params.job,
    candidate: Math.max(params.naturalNext, params.lowerBoundMs),
    deferredNotifications: params.deferredNotifications,
  });
}

export function resolveTransientCronRetryDecision(params: {
  cronConfig?: CronConfig;
  error: string | undefined;
  errorClassification?: CronRunErrorClassification;
  lastErrorReason?: CronJob["state"]["lastErrorReason"];
  executionStarted?: boolean;
  consecutiveErrors: number | undefined;
}): TransientCronRetryDecision {
  if (params.errorClassification?.kind === "permanent") {
    return {
      retryable: false,
      consecutiveErrors: params.consecutiveErrors ?? 0,
      reason: "permanent error",
    };
  }
  const retryHint = resolveCronExecutionRetryHint({
    error: params.error,
    retryOn: undefined,
    classifiedReason:
      params.errorClassification?.kind === "reason"
        ? params.errorClassification.reason
        : params.lastErrorReason,
    executionStarted: params.executionStarted,
  });
  const consecutiveErrors = params.consecutiveErrors ?? 0;
  if (!retryHint.retryable) {
    return {
      retryable: false,
      consecutiveErrors,
      retryCategory: retryHint.category,
      reason: "permanent error",
    };
  }
  if (consecutiveErrors > DEFAULT_MAX_TRANSIENT_RETRIES) {
    return {
      retryable: false,
      consecutiveErrors,
      retryCategory: retryHint.category,
      reason: "max retries exhausted",
    };
  }
  return {
    retryable: true,
    consecutiveErrors,
    retryCategory: retryHint.category,
    backoffMs: errorBackoffMs(
      consecutiveErrors,
      DEFAULT_ERROR_BACKOFF_SCHEDULE_MS.slice(0, DEFAULT_MAX_TRANSIENT_RETRIES),
    ),
    reason: "transient retry",
  };
}

export function resolveDisabledHeartbeatOneShotRetryDecision(params: {
  cronConfig?: CronConfig;
  consecutiveSkipped: number | undefined;
}): DisabledHeartbeatOneShotRetryDecision {
  const consecutiveSkipped = params.consecutiveSkipped ?? 0;
  if (consecutiveSkipped > DEFAULT_MAX_TRANSIENT_RETRIES) {
    return {
      retryable: false,
      consecutiveSkipped,
      reason: "max retries exhausted",
    };
  }
  return {
    retryable: true,
    consecutiveSkipped,
    backoffMs: errorBackoffMs(
      consecutiveSkipped,
      DEFAULT_ERROR_BACKOFF_SCHEDULE_MS.slice(0, DEFAULT_MAX_TRANSIENT_RETRIES),
    ),
    reason: "disabled heartbeat retry",
  };
}

export function normalizeQueuedSystemEventHandle(
  result: CronSystemEventEnqueueResult,
): QueuedSystemEventHandle {
  if (typeof result === "boolean") {
    return { accepted: result };
  }
  if (result && typeof result === "object") {
    return {
      accepted: result.accepted !== false,
      ...(result.remove ? { remove: result.remove } : {}),
    };
  }
  return { accepted: true };
}

export function removeQueuedSystemEventHandle(
  state: CronServiceState,
  job: CronJob,
  queued: QueuedSystemEventHandle,
) {
  if (!queued.accepted || !queued.remove) {
    return;
  }
  try {
    queued.remove();
  } catch (err) {
    state.deps.log.warn(
      { jobId: job.id, jobName: job.name, err },
      "cron: failed to remove undelivered main-session system event",
    );
  }
}

export function shouldRetryDisabledHeartbeatOneShot(
  job: CronJob,
  result: { status: CronRunStatus; error?: string },
): boolean {
  return (
    job.schedule.kind === "at" &&
    job.sessionTarget === "main" &&
    job.wakeMode === "now" &&
    result.status === "skipped" &&
    result.error === HEARTBEAT_SKIP_DISABLED
  );
}

export function isScheduledTerminalOneShotRetry(
  job: CronJob,
  lastRunStatus: CronRunStatus,
  lastRun: unknown,
  nextRun: unknown,
): boolean {
  if (
    !isJobEnabled(job) ||
    typeof nextRun !== "number" ||
    typeof lastRun !== "number" ||
    nextRun <= lastRun
  ) {
    return false;
  }
  if (lastRunStatus === "error") {
    return true;
  }
  return (
    lastRunStatus === "skipped" &&
    job.sessionTarget === "main" &&
    job.wakeMode === "now" &&
    job.state.lastError === HEARTBEAT_SKIP_DISABLED
  );
}

export function resolveDeliveryState(params: {
  job: CronJob;
  runStatus: CronRunStatus;
  delivery?: CronDeliveryTrace;
  delivered?: boolean;
  deliveryAttempted?: boolean;
  error?: string;
}): CronResolvedDeliveryState {
  const primaryDeliveryPlan = resolveCronDeliveryPlan(params.job);
  const primaryDeliveryRequested = primaryDeliveryPlan.requested;
  const noFailureNotification = { status: "not-requested" as const };
  if (!primaryDeliveryRequested) {
    if (primaryDeliveryPlan.mode === "webhook") {
      if (params.delivered === true) {
        return {
          delivered: true,
          status: "delivered",
          failureNotification: noFailureNotification,
        };
      }
      if (params.deliveryAttempted === true) {
        return {
          delivered: false,
          status: "not-delivered",
          error: params.error,
          failureNotification: noFailureNotification,
        };
      }
    }
    return {
      status: "not-requested",
      failureNotification: noFailureNotification,
    };
  }
  if (
    params.runStatus === "error" &&
    !(params.delivered === true && params.delivery?.delivered === true)
  ) {
    if (params.delivered !== undefined) {
      return {
        delivered: false,
        status: "not-delivered",
        error: params.error,
        failureNotification: noFailureNotification,
      };
    }
    return {
      status: "unknown",
      error: params.error,
      failureNotification: noFailureNotification,
    };
  }
  if (params.delivered === true) {
    return {
      delivered: true,
      status: "delivered",
      failureNotification: { status: "not-requested" },
    };
  }
  if (params.delivered === false) {
    return {
      delivered: false,
      status: "not-delivered",
      error: params.error,
      failureNotification: { status: "not-requested" },
    };
  }
  return { status: "unknown", failureNotification: { status: "not-requested" } };
}
