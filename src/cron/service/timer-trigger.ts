import type { CronConfig } from "../../config/types.cron.js";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "../delivery-plan.js";
import { type CronRetryOn, resolveCronExecutionRetryHint } from "../retry-hint.js";
import type {
  CronDeliveryStatus,
  CronFailureNotificationDelivery,
  CronJob,
  CronRunErrorClassification,
  CronRunStatus,
} from "../types.js";
import { DEFAULT_ERROR_BACKOFF_SCHEDULE_MS, errorBackoffMs, isJobEnabled } from "./jobs.js";
import type { CronServiceState, CronSystemEventEnqueueResult } from "./state.js";
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

export function resolveCronNextRunWithLowerBound(params: {
  state: CronServiceState;
  job: CronJob;
  naturalNext: number | undefined;
  lowerBoundMs: number;
  context: "completion" | "error_backoff";
}): number | undefined {
  if (params.naturalNext === undefined) {
    params.state.deps.log.warn(
      {
        jobId: params.job.id,
        jobName: params.job.name,
        context: params.context,
      },
      "cron: next run unresolved; clearing schedule to avoid a refire loop",
    );
    return undefined;
  }
  return Math.max(params.naturalNext, params.lowerBoundMs);
}

function resolveRetryConfig() {
  return {
    maxAttempts: DEFAULT_MAX_TRANSIENT_RETRIES,
    backoffMs: DEFAULT_ERROR_BACKOFF_SCHEDULE_MS.slice(0, 3),
    retryOn: undefined,
  };
}

export function resolveTransientCronRetryDecision(params: {
  cronConfig?: CronConfig;
  error: string | undefined;
  errorClassification?: CronRunErrorClassification;
  lastErrorReason?: string;
  executionStarted?: boolean;
  consecutiveErrors: number | undefined;
}): TransientCronRetryDecision {
  const retryConfig = resolveRetryConfig();
  if (params.errorClassification?.kind === "permanent") {
    return {
      retryable: false,
      consecutiveErrors: params.consecutiveErrors ?? 0,
      reason: "permanent error",
    };
  }
  const retryHint = resolveCronExecutionRetryHint({
    error: params.error,
    retryOn: retryConfig.retryOn,
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
  if (consecutiveErrors > retryConfig.maxAttempts) {
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
    backoffMs: errorBackoffMs(consecutiveErrors, retryConfig.backoffMs),
    reason: "transient retry",
  };
}

export function resolveDisabledHeartbeatOneShotRetryDecision(params: {
  cronConfig?: CronConfig;
  consecutiveSkipped: number | undefined;
}): DisabledHeartbeatOneShotRetryDecision {
  const retryConfig = resolveRetryConfig();
  const consecutiveSkipped = params.consecutiveSkipped ?? 0;
  if (consecutiveSkipped > retryConfig.maxAttempts) {
    return {
      retryable: false,
      consecutiveSkipped,
      reason: "max retries exhausted",
    };
  }
  return {
    retryable: true,
    consecutiveSkipped,
    backoffMs: errorBackoffMs(consecutiveSkipped, retryConfig.backoffMs),
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
  delivered?: boolean;
  error?: string;
  globalFailureDestination?: CronConfig["failureAlert"];
}): {
  delivered?: boolean;
  status: CronDeliveryStatus;
  error?: string;
  failureNotification: CronFailureNotificationDelivery;
} {
  const primaryDeliveryRequested = resolveCronDeliveryPlan(params.job).requested;
  // Failure destinations can receive alerts even when the primary delivery
  // path was disabled or failed before direct delivery produced an ack.
  const alternateFailureNotificationRequested =
    params.runStatus === "error" &&
    params.job.delivery?.bestEffort !== true &&
    resolveFailureDestination(params.job, params.globalFailureDestination) !== null;
  if (!primaryDeliveryRequested) {
    return {
      status: "not-requested",
      failureNotification: {
        status: alternateFailureNotificationRequested ? "unknown" : "not-requested",
      },
    };
  }
  if (params.runStatus === "error") {
    const failureNotification: CronFailureNotificationDelivery =
      alternateFailureNotificationRequested ? { status: "unknown" } : { status: "delivered" };
    if (params.delivered === true) {
      return {
        delivered: false,
        status: "not-delivered",
        error: params.error,
        failureNotification: alternateFailureNotificationRequested
          ? failureNotification
          : { delivered: true, status: "delivered" },
      };
    }
    if (params.delivered === false) {
      return {
        delivered: false,
        status: "not-delivered",
        error: params.error,
        failureNotification: alternateFailureNotificationRequested
          ? failureNotification
          : {
              delivered: false,
              status: "not-delivered",
              ...(params.error ? { error: params.error } : {}),
            },
      };
    }
    return {
      status: "unknown",
      error: params.error,
      failureNotification: { status: "unknown" },
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
