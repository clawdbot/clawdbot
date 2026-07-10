/** Cron timer loop, execution, catch-up, and run-result state transitions. */
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { resolveFailoverReasonFromError } from "../../agents/failover-error.js";
import { resolveCronTriggerMinIntervalMs } from "../../config/cron-limits.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { CronConfig, CronRetryOn } from "../../config/types.cron.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import {
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  isRetryableHeartbeatBusySkipReason,
} from "../../infra/heartbeat-wake.js";
import {
  beginGatewayRootWorkAdmissionWhenOpen,
  GatewayDrainingError,
} from "../../process/gateway-work-admission.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import {
  registerActiveCronTaskRun,
  startActiveCronTaskRunSettlementGrace,
  trackActiveCronTaskRunSettlement,
} from "../../tasks/cron-task-cancel.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  clearCronJobActive,
  isCronActiveJobMarkerCurrent,
  markCronJobActive,
  type CronActiveJobMarker,
} from "../active-jobs.js";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "../delivery-plan.js";
import { resolveCronExecutionRetryHint } from "../retry-hint.js";
import {
  createCronRunDiagnosticsFromError,
  normalizeCronRunDiagnostics,
  summarizeCronRunDiagnostics,
} from "../run-diagnostics.js";
import { computeNextRunAtMs } from "../schedule.js";
import { sweepCronRunSessions } from "../session-reaper.js";
import type {
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronDeliveryStatus,
  CronDeliveryTrace,
  CronFailureNotificationDelivery,
  CronJob,
  CronRunOutcome,
  CronRunStatus,
  CronRunTelemetry,
} from "../types.js";
import {
  cleanupTimedOutCronAgentRun,
  createCronAgentWatchdog,
  CRON_AGENT_SETUP_WATCHDOG_MS,
} from "./agent-watchdog.js";
import {
  abortErrorMessage,
  isSetupTimeoutErrorText,
  normalizeCronRunErrorText,
  timeoutErrorMessage,
} from "./execution-errors.js";
import {
  failureNotificationDeliveryFromJobState,
  maybeEmitFailureAlert,
  resolveFailureAlert,
} from "./failure-alerts.js";
import {
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  computeJobPreviousRunAtMs,
  computeJobNextRunAtMs,
  errorBackoffMs,
  hasScheduledNextRunAtMs,
  isJobEnabled,
  nextWakeAtMs,
  recomputeNextRunsForMaintenance,
  recordScheduleComputeError,
  resolveJobErrorBackoffUntilMs,
  resolveJobLastRunStatus,
  resolveJobPayloadTextForMain,
} from "./jobs.js";
import { locked } from "./locked.js";
import { emit, type CronServiceState, type CronSystemEventEnqueueResult } from "./state.js";
import { ensureLoaded, persist } from "./store.js";
import {
  resolveMainSessionCronRunSessionKey,
  tryCreateCronTaskRun,
  tryFinishCronTaskRun,
} from "./task-runs.js";
import { resolveCronJobTimeoutMs } from "./timeout-policy.js";

export { DEFAULT_JOB_TIMEOUT_MS } from "./timeout-policy.js";
export { normalizeCronRunErrorText } from "./execution-errors.js";
export { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
export { wake } from "./wake.js";

const MAX_TIMER_DELAY_MS = 60_000;
const HEARTBEAT_SKIP_DISABLED = "disabled";

/**
 * Minimum gap between consecutive fires of the same cron job.  This is a
 * safety net that prevents spin-loops when `computeJobNextRunAtMs` returns
 * a value within the same second as the just-completed run.  The guard
 * is intentionally generous (2 s) so it never masks a legitimate schedule
 * but always breaks an infinite re-trigger cycle.  (See #17821)
 */
const MIN_REFIRE_GAP_MS = 2_000;

const DEFAULT_MISSED_JOB_STAGGER_MS = 5_000;
const DEFAULT_MAX_MISSED_JOBS_PER_RESTART = 5;
const DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS = 2 * 60_000;

type TimedCronRunOutcome = CronRunOutcome &
  CronRunTelemetry & {
    jobId: string;
    job: CronJob;
    taskRunId?: string;
    delivered?: boolean;
    deliveryAttempted?: boolean;
    isolatedAgentSetupTimeout?: IsolatedAgentSetupTimeoutSignal;
    activeJobMarker?: CronActiveJobMarker;
    startedAt: number;
    endedAt: number;
    triggerEval?: CronTriggerEvalOutcome;
  };

export type CronTriggerEvalOutcome = {
  fired: boolean;
  stateChanged: boolean;
  state?: unknown;
  busy?: true;
};

export type IsolatedAgentSetupTimeoutSignal = {
  error: string;
  timeoutMs: number;
  otherCronJobsActiveAtTimeout: boolean;
};

type IsolatedAgentSetupTimeoutResult = {
  jobId: string;
  job: CronJob;
  isolatedAgentSetupTimeout?: IsolatedAgentSetupTimeoutSignal;
};

type CronCoreRunOutcome = Awaited<ReturnType<typeof executeJobCore>> & {
  isolatedAgentSetupTimeout?: IsolatedAgentSetupTimeoutSignal;
};

type StartupCatchupCandidate = {
  jobId: string;
  job: CronJob;
  reservedAtMs: number;
};

type StartupDeferredJob = {
  jobId: string;
  delayMs?: number;
};

type StartupCatchupPlan = {
  candidates: StartupCatchupCandidate[];
  deferredJobs: StartupDeferredJob[];
};

type ExecuteJobCoreOptions = {
  onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
  onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
  onLaneWait?: (info?: { waiting?: boolean }) => void;
};

/**
 * Carries the already-resolved run attribution from watchdog-visible execution
 * state into a timer-built error outcome. The wall-clock/cancel paths return
 * their own outcome (the inner run result loses the Promise.race), so without
 * this the persisted cron_run_logs row drops provider/model/session for a
 * post-runner timeout or cancel even though they were already known. Stays
 * empty before the runner starts, so pre-execution setup timeouts read blank.
 */
function cronRunAttributionFromExecution(execution?: CronAgentExecutionStarted): {
  provider?: string;
  model?: string;
  sessionId?: string;
  sessionKey?: string;
} {
  if (!execution) {
    return {};
  }
  return {
    provider: execution.provider,
    model: execution.model,
    sessionId: execution.sessionId,
    sessionKey: execution.sessionKey,
  };
}

/** Executes cron job core logic with the configured wall-clock timeout and watchdog cleanup. */
export async function executeJobCoreWithTimeout(
  state: CronServiceState,
  job: CronJob,
  opts?: { runId?: string; activeJobMarker?: CronActiveJobMarker },
): Promise<CronCoreRunOutcome> {
  const runAbortController = new AbortController();
  const operatorCancellationMarker = Symbol("cron-operator-cancelled");
  let resolveOperatorCancellation: ((value: typeof operatorCancellationMarker) => void) | undefined;
  const operatorCancellationPromise = new Promise<typeof operatorCancellationMarker>((resolve) => {
    resolveOperatorCancellation = resolve;
  });
  const createOperatorCancellationOutcome = (execution?: CronAgentExecutionStarted) => {
    const error = abortErrorMessage(runAbortController.signal);
    return {
      status: "error" as const,
      error,
      ...cronRunAttributionFromExecution(execution),
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
        nowMs: state.deps.nowMs,
      }),
    };
  };
  if (!isCronActiveJobMarkerCurrent(opts?.activeJobMarker)) {
    runAbortController.abort("Gateway restarting.");
    return createOperatorCancellationOutcome();
  }
  const releaseCronTaskRun =
    job.sessionTarget !== "main"
      ? registerActiveCronTaskRun({
          runId: opts?.runId ?? `cron-active:${job.id}`,
          controller: runAbortController,
          onCancel: () => resolveOperatorCancellation?.(operatorCancellationMarker),
        })
      : undefined;
  const jobTimeoutMs = resolveCronJobTimeoutMs(job);
  try {
    if (typeof jobTimeoutMs !== "number") {
      // No wall-clock timeout means no watchdog to accumulate the resolved run
      // identity, so track it locally from the same execution callbacks. Without
      // this, an operator-cancel row for a timeout-disabled isolated run drops
      // provider/model/session even though they were already known.
      let activeExecution: CronAgentExecutionStarted | undefined;
      const accumulateExecution = (info?: CronAgentExecutionStarted) => {
        if (info) {
          activeExecution = { ...activeExecution, ...info };
        }
      };
      const corePromise = executeJobCore(state, job, runAbortController.signal, {
        onExecutionStarted: accumulateExecution,
        onExecutionPhase: accumulateExecution,
      });
      trackActiveCronTaskRunSettlement(corePromise);
      void corePromise.catch((err: unknown) => {
        if (runAbortController.signal.aborted) {
          state.deps.log.warn(
            { jobId: job.id, err: String(err) },
            "cron: job core rejected after cancellation abort",
          );
        }
      });
      const first = await Promise.race([corePromise, operatorCancellationPromise]);
      if (first !== operatorCancellationMarker) {
        return first;
      }
      startActiveCronTaskRunSettlementGrace();
      return createOperatorCancellationOutcome(activeExecution);
    }

    let timeoutReason: string | undefined;
    const timeoutMarker = Symbol("cron-timeout");
    let resolveTimeout: ((value: typeof timeoutMarker) => void) | undefined;
    const timeoutPromise = new Promise<typeof timeoutMarker>((resolve) => {
      resolveTimeout = resolve;
    });

    // Detached agent runs report setup phases separately; defer the wall-clock
    // timeout until the runner starts so cold setup gets a clearer failure reason.
    const deferTimeoutUntilExecutionStart =
      job.sessionTarget !== "main" && job.payload.kind === "agentTurn";
    const triggerTimeout = (reason: string) => {
      timeoutReason = reason;
      if (!runAbortController.signal.aborted) {
        const timeoutError = new Error(reason);
        timeoutError.name = "TimeoutError";
        runAbortController.abort(timeoutError);
      }
      resolveTimeout?.(timeoutMarker);
    };
    const watchdog = createCronAgentWatchdog({
      deferUntilRunner: deferTimeoutUntilExecutionStart,
      jobTimeoutMs,
      triggerTimeout,
    });
    const noteLaneState = (info?: { waiting?: boolean }) => {
      if (info?.waiting === false) {
        watchdog.noteLaneAdmitted();
        return;
      }
      watchdog.noteLaneWait();
    };
    const corePromise = executeJobCore(state, job, runAbortController.signal, {
      onExecutionStarted: deferTimeoutUntilExecutionStart ? watchdog.noteRunnerStarted : undefined,
      onExecutionPhase: deferTimeoutUntilExecutionStart ? watchdog.notePhase : undefined,
      onLaneWait: deferTimeoutUntilExecutionStart ? noteLaneState : undefined,
    });
    trackActiveCronTaskRunSettlement(corePromise);
    watchdog.start();
    void corePromise.catch((err: unknown) => {
      if (runAbortController.signal.aborted) {
        state.deps.log.warn(
          { jobId: job.id, err: String(err) },
          "cron: job core rejected after timeout abort",
        );
      }
    });
    try {
      const first = await Promise.race([corePromise, timeoutPromise, operatorCancellationPromise]);
      if (first === operatorCancellationMarker) {
        startActiveCronTaskRunSettlementGrace();
        return createOperatorCancellationOutcome(watchdog.activeExecution());
      }
      if (first !== timeoutMarker) {
        return first;
      }
      startActiveCronTaskRunSettlementGrace();
      const activeExecution = watchdog.activeExecution();
      await cleanupTimedOutCronAgentRun(state, job, jobTimeoutMs, activeExecution);
      const error = timeoutReason ?? timeoutErrorMessage(activeExecution);
      const observedLaneWait = watchdog.observedLaneWait();
      const isolatedAgentSetupTimeout =
        job.sessionTarget === "isolated" && isSetupTimeoutErrorText(error) && !observedLaneWait
          ? {
              error,
              timeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS,
              otherCronJobsActiveAtTimeout: false,
            }
          : undefined;
      return {
        status: "error",
        error,
        ...cronRunAttributionFromExecution(activeExecution),
        diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
          nowMs: state.deps.nowMs,
        }),
        ...(isolatedAgentSetupTimeout ? { isolatedAgentSetupTimeout } : {}),
      };
    } finally {
      watchdog.dispose();
    }
  } finally {
    releaseCronTaskRun?.();
  }
}

function notifyIsolatedAgentSetupTimeout(
  state: CronServiceState,
  job: CronJob,
  error: string,
  timeoutMs: number,
): boolean {
  const notify = state.deps.onIsolatedAgentSetupTimeout;
  if (!notify) {
    return false;
  }
  try {
    void Promise.resolve(notify({ job, error, timeoutMs })).catch((err: unknown) => {
      state.restartRecoveryPending = false;
      state.deps.log.warn(
        { jobId: job.id, err: String(err) },
        "cron: isolated setup timeout handler failed",
      );
      armTimer(state);
    });
    return true;
  } catch (err) {
    state.deps.log.warn(
      { jobId: job.id, err: String(err) },
      "cron: isolated setup timeout handler failed",
    );
    return false;
  }
}

export function maybeNotifyIsolatedAgentSetupTimeout(
  state: CronServiceState,
  result: IsolatedAgentSetupTimeoutResult,
): boolean {
  const signal = result.isolatedAgentSetupTimeout;
  if (!signal) {
    return false;
  }
  const notified = notifyIsolatedAgentSetupTimeout(
    state,
    result.job,
    signal.error,
    signal.timeoutMs,
  );
  if (!notified) {
    return false;
  }
  return true;
}

function resolveRunConcurrency(state: CronServiceState): number {
  return resolveIntegerOption(state.deps.cronConfig?.maxConcurrentRuns, 1, { min: 1 });
}

function resolveMainSessionCronDeliveryContext(
  state: CronServiceState,
  job: CronJob,
): DeliveryContext | undefined {
  const targetSessionKey = job.sessionKey?.trim();
  if (!targetSessionKey) {
    return undefined;
  }
  const explicitAgentId = job.agentId?.trim();
  const agentId = normalizeAgentId(
    explicitAgentId || resolveAgentIdFromSessionKey(targetSessionKey),
  );
  const storePath = state.deps.resolveSessionStorePath?.(agentId) ?? state.deps.sessionStorePath;
  if (!storePath) {
    return undefined;
  }
  try {
    const sessionEntry = loadSessionEntry({
      agentId,
      sessionKey: targetSessionKey,
      storePath,
    });
    return deliveryContextFromSession(sessionEntry);
  } catch {
    return undefined;
  }
}

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

function resolveCronNextRunWithLowerBound(params: {
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

function resolveRetryConfig(cronConfig?: CronConfig) {
  const retry = cronConfig?.retry;
  return {
    maxAttempts:
      typeof retry?.maxAttempts === "number" ? retry.maxAttempts : DEFAULT_MAX_TRANSIENT_RETRIES,
    backoffMs:
      Array.isArray(retry?.backoffMs) && retry.backoffMs.length > 0
        ? retry.backoffMs
        : DEFAULT_ERROR_BACKOFF_SCHEDULE_MS.slice(0, 3),
    retryOn: Array.isArray(retry?.retryOn) && retry.retryOn.length > 0 ? retry.retryOn : undefined,
  };
}

function resolveTransientCronRetryDecision(params: {
  cronConfig?: CronConfig;
  error: string | undefined;
  lastErrorReason?: string;
  consecutiveErrors: number | undefined;
}): TransientCronRetryDecision {
  const retryConfig = resolveRetryConfig(params.cronConfig);
  const retryHint = resolveCronExecutionRetryHint(
    params.error,
    retryConfig.retryOn,
    params.lastErrorReason,
  );
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

function resolveDisabledHeartbeatOneShotRetryDecision(params: {
  cronConfig?: CronConfig;
  consecutiveSkipped: number | undefined;
}): DisabledHeartbeatOneShotRetryDecision {
  const retryConfig = resolveRetryConfig(params.cronConfig);
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

function normalizeQueuedSystemEventHandle(
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

function removeQueuedSystemEventHandle(
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

function shouldRetryDisabledHeartbeatOneShot(
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

function isScheduledTerminalOneShotRetry(
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

function resolveDeliveryState(params: {
  job: CronJob;
  runStatus: CronRunStatus;
  delivered?: boolean;
  error?: string;
  globalFailureDestination?: CronConfig["failureDestination"];
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

/** Applies run outcome state, delivery state, backoff/next-run scheduling, and delete-after-run policy. */
export function applyJobResult(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: CronRunStatus;
    error?: string;
    diagnostics?: CronRunOutcome["diagnostics"];
    delivered?: boolean;
    provider?: string;
    startedAt: number;
    endedAt: number;
  },
  opts?: {
    // Preserve recurring "every" anchors for manual force runs.
    preserveSchedule?: boolean;
  },
): boolean {
  const prevLastRunAtMs = job.state.lastRunAtMs;
  const computeNextWithPreservedLastRun = (nowMs: number) => {
    const saved = job.state.lastRunAtMs;
    job.state.lastRunAtMs = prevLastRunAtMs;
    try {
      return computeJobNextRunAtMs(job, nowMs);
    } finally {
      job.state.lastRunAtMs = saved;
    }
  };
  job.state.runningAtMs = undefined;
  job.state.lastRunAtMs = result.startedAt;
  job.state.lastRunStatus = result.status;
  job.state.lastStatus = result.status;
  job.state.lastDurationMs = Math.max(0, result.endedAt - result.startedAt);
  job.state.lastError = result.error;
  job.state.lastDiagnostics = normalizeCronRunDiagnostics(result.diagnostics);
  job.state.lastDiagnosticSummary = summarizeCronRunDiagnostics(job.state.lastDiagnostics);
  job.state.lastErrorReason =
    result.status === "error" && typeof result.error === "string"
      ? (resolveFailoverReasonFromError(result.error, result.provider) ?? undefined)
      : undefined;
  if (result.status === "error") {
    state.deps.log.warn(
      {
        jobId: job.id,
        jobName: job.name,
        error: result.error,
        diagnosticsSummary: job.state.lastDiagnosticSummary,
      },
      "cron: job run returned error status",
    );
  }
  const deliveryState = resolveDeliveryState({
    job,
    runStatus: result.status,
    delivered: result.delivered,
    error: result.error,
    globalFailureDestination: state.deps.cronConfig?.failureDestination,
  });
  job.state.lastDelivered = deliveryState.delivered;
  job.state.lastDeliveryStatus = deliveryState.status;
  job.state.lastDeliveryError =
    deliveryState.status === "not-delivered" && deliveryState.error
      ? deliveryState.error
      : undefined;
  job.state.lastFailureNotificationDelivered = deliveryState.failureNotification.delivered;
  job.state.lastFailureNotificationDeliveryStatus = deliveryState.failureNotification.status;
  job.state.lastFailureNotificationDeliveryError = deliveryState.failureNotification.error;
  job.updatedAtMs = result.endedAt;

  // Track consecutive errors for backoff / auto-disable; skipped runs use a
  // separate counter so opt-in skip alerts do not affect retry behavior.
  const previousConsecutiveErrors = job.state.consecutiveErrors ?? 0;
  const alertConfig = resolveFailureAlert(state, job);
  if (result.status === "error") {
    job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
    job.state.consecutiveSkipped = 0;
    maybeEmitFailureAlert(state, {
      job,
      alertConfig,
      status: "error",
      error: result.error,
      provider: result.provider,
      consecutiveCount: job.state.consecutiveErrors,
    });
  } else if (result.status === "skipped") {
    job.state.consecutiveErrors = 0;
    job.state.consecutiveSkipped = (job.state.consecutiveSkipped ?? 0) + 1;
    if (alertConfig?.includeSkipped) {
      maybeEmitFailureAlert(state, {
        job,
        alertConfig,
        status: "skipped",
        error: result.error,
        provider: result.provider,
        consecutiveCount: job.state.consecutiveSkipped,
      });
    } else {
      job.state.lastFailureAlertAtMs = undefined;
    }
  } else {
    job.state.consecutiveErrors = 0;
    job.state.consecutiveSkipped = 0;
    job.state.lastFailureAlertAtMs = undefined;
  }

  const shouldDelete =
    job.schedule.kind === "at" && job.deleteAfterRun === true && result.status === "ok";
  const retryDisabledHeartbeatOneShot = shouldRetryDisabledHeartbeatOneShot(job, result);

  if (!shouldDelete) {
    if (job.schedule.kind === "at") {
      if (retryDisabledHeartbeatOneShot) {
        const retryDecision = resolveDisabledHeartbeatOneShotRetryDecision({
          cronConfig: state.deps.cronConfig,
          consecutiveSkipped: job.state.consecutiveSkipped,
        });
        if (retryDecision.retryable && retryDecision.backoffMs !== undefined) {
          job.enabled = true;
          job.state.nextRunAtMs = result.endedAt + retryDecision.backoffMs;
          state.deps.log.info(
            {
              jobId: job.id,
              jobName: job.name,
              consecutiveSkipped: retryDecision.consecutiveSkipped,
              backoffMs: retryDecision.backoffMs,
              nextRunAtMs: job.state.nextRunAtMs,
            },
            "cron: scheduling one-shot retry after disabled heartbeat",
          );
        } else {
          job.enabled = false;
          job.state.nextRunAtMs = undefined;
          state.deps.log.warn(
            {
              jobId: job.id,
              jobName: job.name,
              consecutiveSkipped: retryDecision.consecutiveSkipped,
              reason: retryDecision.reason,
            },
            "cron: disabling one-shot job after disabled heartbeat retries",
          );
        }
      } else if (result.status === "ok" || result.status === "skipped") {
        // One-shot done or skipped: disable to prevent tight-loop (#11452).
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
      } else if (result.status === "error") {
        const retryDecision = resolveTransientCronRetryDecision({
          cronConfig: state.deps.cronConfig,
          error: result.error,
          lastErrorReason: job.state.lastErrorReason,
          consecutiveErrors: job.state.consecutiveErrors,
        });
        if (retryDecision.retryable && retryDecision.backoffMs !== undefined) {
          // Schedule retry with backoff (#24355).
          job.state.nextRunAtMs = result.endedAt + retryDecision.backoffMs;
          state.deps.log.info(
            {
              jobId: job.id,
              jobName: job.name,
              consecutiveErrors: retryDecision.consecutiveErrors,
              backoffMs: retryDecision.backoffMs,
              nextRunAtMs: job.state.nextRunAtMs,
              retryCategory: retryDecision.retryCategory,
            },
            "cron: scheduling one-shot retry after transient error",
          );
        } else {
          // Permanent error or max retries exhausted: disable.
          // Note: deleteAfterRun:true only triggers on ok (see shouldDelete above),
          // so exhausted-retry jobs are disabled but intentionally kept in the store
          // to preserve the error state for inspection.
          job.enabled = false;
          job.state.nextRunAtMs = undefined;
          state.deps.log.warn(
            {
              jobId: job.id,
              jobName: job.name,
              consecutiveErrors: retryDecision.consecutiveErrors,
              error: result.error,
              reason: retryDecision.reason,
              retryCategory: retryDecision.retryCategory,
            },
            "cron: disabling one-shot job after error",
          );
        }
      }
    } else if (result.status === "error" && isJobEnabled(job)) {
      const retryDecision = resolveTransientCronRetryDecision({
        cronConfig: state.deps.cronConfig,
        error: result.error,
        lastErrorReason: job.state.lastErrorReason,
        consecutiveErrors: job.state.consecutiveErrors,
      });
      let normalNext: number | undefined;
      let normalNextComputed = false;
      const computeNormalNext = () => {
        if (!normalNextComputed) {
          try {
            normalNext =
              opts?.preserveSchedule && job.schedule.kind === "every"
                ? computeNextWithPreservedLastRun(result.endedAt)
                : (retryDecision.retryable || previousConsecutiveErrors > 0) &&
                    job.schedule.kind === "every"
                  ? computeNextRunAtMs(job.schedule, result.endedAt)
                  : computeJobNextRunAtMs(job, result.endedAt);
          } catch (err) {
            // If the schedule expression/timezone throws (croner edge cases),
            // record the schedule error (auto-disables after repeated failures)
            // and fall back to backoff-only schedule so the state update is not lost.
            recordScheduleComputeError({ state, job, err });
          }
          normalNextComputed = true;
        }
        return normalNext;
      };
      if (
        !opts?.preserveSchedule &&
        retryDecision.retryable &&
        retryDecision.backoffMs !== undefined
      ) {
        normalNext = computeNormalNext();
        const retryNextRunAtMs = result.endedAt + retryDecision.backoffMs;
        if (normalNext === undefined) {
          // Preserve the unresolved-cron guard (#66019): do not synthesize a
          // retry when the schedule cannot produce a next scheduled slot.
        } else if (retryNextRunAtMs < normalNext) {
          job.state.nextRunAtMs = retryNextRunAtMs;
          state.deps.log.info(
            {
              jobId: job.id,
              jobName: job.name,
              consecutiveErrors: retryDecision.consecutiveErrors,
              backoffMs: retryDecision.backoffMs,
              nextRunAtMs: job.state.nextRunAtMs,
              normalNextRunAtMs: normalNext,
              retryCategory: retryDecision.retryCategory,
            },
            "cron: scheduling recurring retry after transient error",
          );
          return shouldDelete;
        }
      }
      // Apply exponential backoff for errored jobs to prevent retry storms.
      const backoff = errorBackoffMs(
        job.state.consecutiveErrors ?? 1,
        state.deps.cronConfig?.retry?.backoffMs ?? DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
      );
      normalNext = computeNormalNext();
      const backoffNext = result.endedAt + backoff;
      // Use whichever is later: the natural next run or the backoff delay.
      job.state.nextRunAtMs =
        job.schedule.kind === "cron"
          ? resolveCronNextRunWithLowerBound({
              state,
              job,
              naturalNext: normalNext,
              lowerBoundMs: backoffNext,
              context: "error_backoff",
            })
          : normalNext !== undefined
            ? Math.max(normalNext, backoffNext)
            : backoffNext;
      state.deps.log.info(
        {
          jobId: job.id,
          consecutiveErrors: job.state.consecutiveErrors,
          backoffMs: backoff,
          nextRunAtMs: job.state.nextRunAtMs,
        },
        "cron: applying error backoff",
      );
    } else if (isJobEnabled(job)) {
      let naturalNext: number | undefined;
      try {
        naturalNext =
          opts?.preserveSchedule && job.schedule.kind === "every"
            ? computeNextWithPreservedLastRun(result.endedAt)
            : previousConsecutiveErrors > 0 && job.schedule.kind === "every"
              ? computeNextRunAtMs(job.schedule, result.endedAt)
              : computeJobNextRunAtMs(job, result.endedAt);
      } catch (err) {
        // If the schedule expression/timezone throws (croner edge cases),
        // record the schedule error (auto-disables after repeated failures)
        // so a persistent throw doesn't cause a MIN_REFIRE_GAP_MS hot loop.
        recordScheduleComputeError({ state, job, err });
      }
      if (job.schedule.kind === "cron") {
        // Safety net: ensure the next fire is at least MIN_REFIRE_GAP_MS
        // after the current run ended.  Prevents spin-loops when the
        // schedule computation lands in the same second due to
        // timezone/croner edge cases (see #17821).
        // Trigger schedules obey the operator floor even when a cron expression
        // would otherwise refire sooner after a successful payload run.
        const minNext =
          result.endedAt +
          Math.max(
            MIN_REFIRE_GAP_MS,
            job.trigger ? resolveCronTriggerMinIntervalMs(state.deps.cronConfig) : 0,
          );
        job.state.nextRunAtMs = resolveCronNextRunWithLowerBound({
          state,
          job,
          naturalNext,
          lowerBoundMs: minNext,
          context: "completion",
        });
      } else {
        job.state.nextRunAtMs =
          naturalNext !== undefined && job.trigger
            ? Math.max(
                naturalNext,
                result.endedAt + resolveCronTriggerMinIntervalMs(state.deps.cronConfig),
              )
            : naturalNext;
      }
    } else {
      job.state.nextRunAtMs = undefined;
    }
  }

  return shouldDelete;
}

function applyTriggerEvaluationState(
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

/** Persists fired/error evaluation metadata and applies successful once-disarm policy. */
export function applyTriggerRunResult(
  job: CronJob,
  result: { status: CronRunStatus; endedAt: number; triggerEval?: CronTriggerEvalOutcome },
): void {
  if (!result.triggerEval) {
    return;
  }
  // Fired-run trigger state persists only on payload success: a failed or
  // skipped run keeps the previous state so the next evaluation re-detects
  // the change and fires again instead of silently losing the event.
  const persistedEval =
    result.status === "ok"
      ? result.triggerEval
      : { ...result.triggerEval, stateChanged: false, state: undefined };
  applyTriggerEvaluationState(job, persistedEval, result.endedAt);
  // A once trigger disarms only after the fired payload succeeds. Errors keep
  // it armed so the normal backoff path can evaluate and retry later.
  if (result.triggerEval.fired && job.trigger?.once === true && result.status === "ok") {
    job.enabled = false;
    job.state.nextRunAtMs = undefined;
  }
}

/** Applies a quiet trigger tick without mutating normal run-history state. */
export function applyTriggerNoFireResult(
  state: CronServiceState,
  job: CronJob,
  result: { startedAt: number; endedAt: number; triggerEval: CronTriggerEvalOutcome },
): void {
  job.state.runningAtMs = undefined;
  job.updatedAtMs = result.endedAt;
  if (!result.triggerEval.busy) {
    // A non-firing evaluation is successful scheduler work, not a payload run;
    // reset error machinery while leaving lastRun/delivery history untouched.
    job.state.consecutiveErrors = 0;
    job.state.scheduleErrorCount = 0;
    job.state.lastFailureAlertAtMs = undefined;
    applyTriggerEvaluationState(job, result.triggerEval, result.endedAt);
  }
  try {
    // Job-level computation keeps per-job cron staggering intact on quiet
    // ticks; raw schedule math would collapse watchers onto exact boundaries.
    const naturalNext = computeJobNextRunAtMs(job, result.endedAt);
    const floorMs = Math.max(
      MIN_REFIRE_GAP_MS,
      resolveCronTriggerMinIntervalMs(state.deps.cronConfig),
    );
    // Quiet ticks still advance the schedule; the floor prevents scripts from
    // becoming a headless hot loop even when cron resolves inside the window.
    job.state.nextRunAtMs =
      naturalNext === undefined ? undefined : Math.max(naturalNext, result.endedAt + floorMs);
  } catch (err) {
    recordScheduleComputeError({ state, job, err });
  }
}

function applyOutcomeToStoredJob(state: CronServiceState, result: TimedCronRunOutcome): void {
  tryFinishCronTaskRun(state, result);
  const store = state.store;
  if (!store) {
    return;
  }
  const jobs = store.jobs;
  const job = jobs.find((entry) => entry.id === result.jobId);
  if (!job) {
    if (result.status === "ok" && result.triggerEval?.fired === false) {
      return;
    }
    if (result.status === "ok") {
      // A manual/queued run may finish after the job was removed. Preserve the
      // successful run log state without resurrecting the job in the store.
      applyJobResult(state, result.job, {
        status: result.status,
        error: result.error,
        diagnostics: result.diagnostics,
        delivered: result.delivered,
        provider: result.provider,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
      });
      emitJobFinished(state, result.job, result, result.startedAt);
      state.deps.log.info(
        { jobId: result.jobId },
        "cron: finalized successful run after job was removed during execution",
      );
      return;
    }
    state.deps.log.warn(
      { jobId: result.jobId },
      "cron: applyOutcomeToStoredJob — job not found after forceReload, result discarded",
    );
    return;
  }

  if (result.status === "ok" && result.triggerEval && !result.triggerEval.fired) {
    // Quiet trigger ticks intentionally emit no finished event: run history,
    // plugin hooks, and completion notifications represent payload runs only.
    applyTriggerNoFireResult(state, job, {
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      triggerEval: result.triggerEval,
    });
    state.pendingCatchupDeferralJobIds.delete(job.id);
    return;
  }

  const shouldDelete = applyJobResult(state, job, {
    status: result.status,
    error: result.error,
    diagnostics: result.diagnostics,
    delivered: result.delivered,
    provider: result.provider,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
  });
  applyTriggerRunResult(job, result);
  state.pendingCatchupDeferralJobIds.delete(job.id);

  emitJobFinished(state, job, result, result.startedAt);

  if (shouldDelete) {
    store.jobs = jobs.filter((entry) => entry.id !== job.id);
    emit(state, { jobId: job.id, action: "removed", job });
  }
}

function clearActiveMarkersForOutcomes(outcomes: readonly TimedCronRunOutcome[]): void {
  for (const outcome of outcomes) {
    clearCronJobActive(outcome.jobId, outcome.activeJobMarker);
  }
}

function filterCurrentCronRunOutcomes(
  outcomes: readonly TimedCronRunOutcome[],
): TimedCronRunOutcome[] {
  return outcomes.filter((outcome) => isCronActiveJobMarkerCurrent(outcome.activeJobMarker));
}

function finishRetiredCronTaskRuns(
  state: CronServiceState,
  outcomes: readonly TimedCronRunOutcome[],
  currentOutcomes: readonly TimedCronRunOutcome[],
): void {
  const current = new Set(currentOutcomes);
  for (const outcome of outcomes) {
    if (!current.has(outcome)) {
      tryFinishCronTaskRun(state, outcome);
    }
  }
}

function releaseUnstartedStartupCatchupReservations(
  state: CronServiceState,
  plan: StartupCatchupPlan,
  outcomes: readonly TimedCronRunOutcome[],
): boolean {
  let changed = false;
  const startedJobIds = new Set(outcomes.map((outcome) => outcome.jobId));
  for (const candidate of plan.candidates) {
    if (startedJobIds.has(candidate.jobId)) {
      continue;
    }
    const job = state.store?.jobs.find((entry) => entry.id === candidate.jobId);
    if (job?.state && job.state.runningAtMs === candidate.reservedAtMs) {
      delete job.state.runningAtMs;
      changed = true;
    }
  }
  return changed;
}

/** Arms the cron timer for the next wake or a maintenance recheck. */
export function armTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
  if (state.stopped || state.schedulingPaused) {
    state.deps.log.debug({}, "cron: armTimer skipped - scheduler stopped");
    return;
  }
  if (!state.deps.cronEnabled) {
    state.deps.log.debug({}, "cron: armTimer skipped - scheduler disabled");
    return;
  }
  if (state.restartRecoveryPending) {
    state.deps.log.warn({}, "cron: armTimer skipped - restart recovery pending");
    return;
  }
  const nextAt = nextWakeAtMs(state);
  if (!nextAt) {
    const jobCount = state.store?.jobs.length ?? 0;
    const enabledCount = state.store?.jobs.filter((j) => j.enabled).length ?? 0;
    const withNextRun =
      state.store?.jobs.filter((j) => j.enabled && hasScheduledNextRunAtMs(j.state.nextRunAtMs))
        .length ?? 0;
    if (enabledCount > 0) {
      armRunningRecheckTimer(state);
      state.deps.log.debug(
        { jobCount, enabledCount, withNextRun, delayMs: MAX_TIMER_DELAY_MS },
        "cron: timer armed for maintenance recheck",
      );
      return;
    }
    state.deps.log.debug(
      { jobCount, enabledCount, withNextRun },
      "cron: armTimer skipped - no jobs with nextRunAtMs",
    );
    return;
  }
  const now = state.deps.nowMs();
  const delay = Math.max(nextAt - now, 0);
  // Floor: when the next wake time is in the past (delay === 0), enforce a
  // minimum delay to prevent a tight setTimeout(0) loop.  This can happen
  // when a job has a stuck runningAtMs marker and a past-due nextRunAtMs:
  // findDueJobs skips the job (blocked by runningAtMs), while
  // recomputeNextRunsForMaintenance intentionally does not advance the
  // past-due nextRunAtMs (per #13992).  The finally block in onTimer then
  // re-invokes armTimer with delay === 0, creating an infinite hot-loop
  // that saturates the event loop and fills the log file to its size cap.
  const flooredDelay = delay === 0 ? MIN_REFIRE_GAP_MS : delay;
  // Wake at least once a minute to avoid schedule drift and recover quickly
  // when the process was paused or wall-clock time jumps.
  const clampedDelay = Math.min(flooredDelay, MAX_TIMER_DELAY_MS);
  // Intentionally avoid an `async` timer callback:
  // Vitest's fake-timer helpers can await async callbacks, which would block
  // tests that simulate long-running jobs. Runtime behavior is unchanged.
  state.timer = setTimeout(() => {
    void onTimer(state).catch((err: unknown) => {
      state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
    });
  }, clampedDelay);
  state.deps.log.debug(
    { nextAt, delayMs: clampedDelay, clamped: delay > MAX_TIMER_DELAY_MS },
    "cron: timer armed",
  );
}

function armRunningRecheckTimer(state: CronServiceState) {
  if (state.stopped || state.schedulingPaused) {
    return;
  }
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => {
    void onTimer(state).catch((err: unknown) => {
      state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
    });
  }, MAX_TIMER_DELAY_MS);
}

/** Handles one cron timer tick under the process-wide root work admission. */
export async function onTimer(state: CronServiceState) {
  let admission;
  try {
    // A restart signal can be rejected after temporarily closing admission.
    // Wait for that decision so the consumed timer is not silently lost.
    admission = await beginGatewayRootWorkAdmissionWhenOpen();
  } catch (err) {
    if (err instanceof GatewayDrainingError) {
      return;
    }
    throw err;
  }
  try {
    await admission.run(async () => await onAdmittedTimer(state));
  } finally {
    admission.release();
  }
}

/** Loads due jobs, reserves them, executes, persists, and re-arms. */
async function onAdmittedTimer(state: CronServiceState) {
  if (state.stopped || state.schedulingPaused) {
    return;
  }
  if (state.restartRecoveryPending) {
    state.deps.log.warn({}, "cron: timer tick skipped - restart recovery pending");
    return;
  }
  if (state.running) {
    // Re-arm the timer so the scheduler keeps ticking even when a job is
    // still executing.  Without this, a long-running job (e.g. an agentTurn
    // exceeding MAX_TIMER_DELAY_MS) causes the clamped 60 s timer to fire
    // while `running` is true.  The early return then leaves no timer set,
    // silently killing the scheduler until the next gateway restart.
    //
    // We use MAX_TIMER_DELAY_MS as a fixed re-check interval to avoid a
    // zero-delay hot-loop when past-due jobs are waiting for the current
    // execution to finish.
    // See: https://github.com/openclaw/openclaw/issues/12025
    armRunningRecheckTimer(state);
    return;
  }
  state.running = true;
  // Keep a watchdog timer armed while a tick is executing. If execution hangs
  // (for example in a provider call), the scheduler still wakes to re-check.
  armRunningRecheckTimer(state);
  try {
    const dueJobs = await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      if (state.stopped || state.restartRecoveryPending) {
        state.deps.log.warn(
          { stopped: state.stopped, restartRecoveryPending: state.restartRecoveryPending },
          "cron: due job reservation skipped - scheduler unavailable",
        );
        return [];
      }
      const dueCheckNow = state.deps.nowMs();
      const due = collectRunnableJobs(state, dueCheckNow);

      if (due.length === 0) {
        // Use maintenance-only recompute to avoid advancing past-due nextRunAtMs
        // values without execution. This prevents jobs from being silently skipped
        // when the timer wakes up but findDueJobs returns empty (see #13992).
        const changed = recomputeNextRunsForMaintenance(state, {
          recomputeExpired: true,
          nowMs: dueCheckNow,
        });
        if (changed) {
          await persist(state);
        }
        return [];
      }

      const now = state.deps.nowMs();
      for (const job of due) {
        job.state.runningAtMs = now;
      }
      await persist(state);
      if (state.stopped) {
        for (const job of due) {
          delete job.state.runningAtMs;
        }
        recomputeNextRunsForMaintenance(state);
        await persist(state);
        return [];
      }

      return due.map((j) => ({
        id: j.id,
        job: j,
        reservedAtMs: now,
      }));
    });

    const runDueJob = async (params: {
      id: string;
      job: CronJob;
      reservedAtMs: number;
    }): Promise<TimedCronRunOutcome> => {
      const { id, job } = params;
      const startedAt = state.deps.nowMs();
      job.state.runningAtMs = startedAt;
      job.state.lastError = undefined;
      const activeJobMarker = markCronJobActive(job.id, {
        preserveAcrossGenerationAdvance: job.sessionTarget === "main",
      });
      emit(state, { jobId: job.id, action: "started", job, runAtMs: startedAt });
      const jobTimeoutMs = resolveCronJobTimeoutMs(job);
      const taskRunId = tryCreateCronTaskRun({ state, job, startedAt });

      try {
        const result = await executeJobCoreWithTimeout(state, job, {
          runId: taskRunId,
          activeJobMarker,
        });
        return {
          jobId: id,
          job,
          taskRunId,
          activeJobMarker,
          ...result,
          startedAt,
          endedAt: state.deps.nowMs(),
        };
      } catch (err) {
        const errorText = normalizeCronRunErrorText(err);
        state.deps.log.warn(
          { jobId: id, jobName: job.name, timeoutMs: jobTimeoutMs ?? null },
          `cron: job failed: ${errorText}`,
        );
        return {
          jobId: id,
          job,
          taskRunId,
          activeJobMarker,
          status: "error",
          error: errorText,
          diagnostics: createCronRunDiagnosticsFromError("cron-setup", errorText, {
            nowMs: state.deps.nowMs,
          }),
          startedAt,
          endedAt: state.deps.nowMs(),
        };
      }
    };

    const finalizeCompletedResults = async (
      completedResults: readonly TimedCronRunOutcome[],
      opts?: { clearOnFailure?: boolean },
    ): Promise<TimedCronRunOutcome[]> => {
      if (completedResults.length === 0) {
        return [];
      }
      let finalizedResults: TimedCronRunOutcome[] = [];
      let finalizationSucceeded = false;
      try {
        const currentResults = filterCurrentCronRunOutcomes(completedResults);
        if (currentResults.length === 0) {
          finishRetiredCronTaskRuns(state, completedResults, currentResults);
          return [];
        }
        await locked(state, async () => {
          await ensureLoaded(state, { forceReload: true, skipRecompute: true });
          finalizedResults = filterCurrentCronRunOutcomes(currentResults);
          finishRetiredCronTaskRuns(state, completedResults, finalizedResults);
          for (const result of finalizedResults) {
            applyOutcomeToStoredJob(state, result);
          }
          if (finalizedResults.length === 0) {
            return;
          }

          // Use maintenance-only recompute to avoid advancing past-due
          // nextRunAtMs values that became due between findDueJobs and this
          // locked block.  The full recomputeNextRuns would silently skip
          // those jobs (advancing nextRunAtMs without execution), causing
          // daily cron schedules to jump 48 h instead of 24 h (#17852).
          recomputeNextRunsForMaintenance(state);
          await persist(state);
        });
        finalizationSucceeded = finalizedResults.length > 0;
        return finalizedResults;
      } finally {
        if (opts?.clearOnFailure !== false || finalizationSucceeded) {
          clearActiveMarkersForOutcomes(completedResults);
        }
      }
    };

    const concurrency = Math.min(resolveRunConcurrency(state), Math.max(1, dueJobs.length));
    const results: (TimedCronRunOutcome | undefined)[] = Array.from({ length: dueJobs.length });
    const claimedIndexes = new Set<number>();
    let reservationReleaseError: unknown;
    let setupTimeoutNotified = false;
    let stopAdmittingDueJobs = false;
    const hasSetupTimeoutRecoveryHandler = state.deps.onIsolatedAgentSetupTimeout !== undefined;
    const releaseUnclaimedDueJobReservations = async () => {
      if (claimedIndexes.size >= dueJobs.length) {
        return;
      }
      await locked(state, async () => {
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });
        for (const [index, due] of dueJobs.entries()) {
          if (claimedIndexes.has(index)) {
            continue;
          }
          const job = state.store?.jobs.find((entry) => entry.id === due.id);
          if (job?.state && job.state.runningAtMs === due.reservedAtMs) {
            delete job.state.runningAtMs;
          }
        }
        recomputeNextRunsForMaintenance(state);
        await persist(state);
      });
    };
    if (state.stopped) {
      await releaseUnclaimedDueJobReservations();
      return;
    }
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      for (;;) {
        if (stopAdmittingDueJobs || state.stopped || state.restartRecoveryPending) {
          stopAdmittingDueJobs = true;
          return;
        }
        const index = cursor++;
        if (index >= dueJobs.length) {
          return;
        }
        const due = dueJobs[index];
        if (!due) {
          return;
        }
        claimedIndexes.add(index);
        const result = await runDueJob(due);
        if (result.isolatedAgentSetupTimeout) {
          let finalizedResults: TimedCronRunOutcome[];
          try {
            finalizedResults = await finalizeCompletedResults([result], { clearOnFailure: false });
          } catch {
            results[index] = result;
            continue;
          }
          if (!hasSetupTimeoutRecoveryHandler || finalizedResults.length === 0) {
            continue;
          }
          if (!setupTimeoutNotified) {
            setupTimeoutNotified = true;
            stopAdmittingDueJobs = true;
            try {
              await releaseUnclaimedDueJobReservations();
            } catch (err) {
              reservationReleaseError = err;
            }
            maybeNotifyIsolatedAgentSetupTimeout(state, result);
          }
          continue;
        }
        results[index] = result;
      }
    });
    await Promise.all(workers);
    if (reservationReleaseError) {
      throw reservationReleaseError instanceof Error
        ? reservationReleaseError
        : new Error(formatErrorMessage(reservationReleaseError));
    }
    if (stopAdmittingDueJobs) {
      await releaseUnclaimedDueJobReservations();
    }

    const completedResults: TimedCronRunOutcome[] = results.filter(
      (entry): entry is TimedCronRunOutcome => entry !== undefined,
    );

    if (completedResults.length > 0) {
      const finalizedResults = await finalizeCompletedResults(completedResults);
      for (const result of finalizedResults) {
        if (
          !setupTimeoutNotified &&
          result.isolatedAgentSetupTimeout &&
          maybeNotifyIsolatedAgentSetupTimeout(state, result)
        ) {
          setupTimeoutNotified = true;
          break;
        }
      }
    }
  } finally {
    // Piggyback session reaper on timer tick (self-throttled to every 5 min).
    // Placed in `finally` so the reaper runs even when a long-running job keeps
    // `state.running` true across multiple timer ticks — the early return at the
    // top of onTimer would otherwise skip the reaper indefinitely.
    const storePaths = new Set<string>();
    if (state.deps.resolveSessionStorePath) {
      const defaultAgentId = state.deps.defaultAgentId ?? DEFAULT_AGENT_ID;
      if (state.store?.jobs?.length) {
        for (const job of state.store.jobs) {
          const agentId =
            typeof job.agentId === "string" && job.agentId.trim() ? job.agentId : defaultAgentId;
          storePaths.add(state.deps.resolveSessionStorePath(agentId));
        }
      } else {
        storePaths.add(state.deps.resolveSessionStorePath(defaultAgentId));
      }
    } else if (state.deps.sessionStorePath) {
      storePaths.add(state.deps.sessionStorePath);
    }

    if (storePaths.size > 0) {
      const nowMs = state.deps.nowMs();
      for (const storePath of storePaths) {
        try {
          await sweepCronRunSessions({
            cronConfig: state.deps.cronConfig,
            sessionStorePath: storePath,
            nowMs,
            log: state.deps.log,
          });
        } catch (err) {
          state.deps.log.warn({ err: String(err), storePath }, "cron: session reaper sweep failed");
        }
      }
    }

    state.running = false;
    armTimer(state);
  }
}

function isRunnableJob(params: {
  state: CronServiceState;
  job: CronJob;
  nowMs: number;
  skipJobIds?: ReadonlySet<string>;
  skipAtIfAlreadyRan?: boolean;
  allowCronMissedRunByLastRun?: boolean;
}): boolean {
  const { job, nowMs } = params;
  if (!job.state) {
    job.state = {};
  }
  if (!isJobEnabled(job)) {
    return false;
  }
  if (params.skipJobIds?.has(job.id)) {
    return false;
  }
  if (typeof job.state.runningAtMs === "number") {
    return false;
  }
  const lastRunStatus = resolveJobLastRunStatus(job);
  if (params.skipAtIfAlreadyRan && job.schedule.kind === "at" && lastRunStatus) {
    // One-shot with terminal status: skip unless it has an explicit retry
    // scheduled after the failed/skipped run (#24355, #91775).
    const lastRun = job.state.lastRunAtMs;
    const nextRun = job.state.nextRunAtMs;
    if (isScheduledTerminalOneShotRetry(job, lastRunStatus, lastRun, nextRun)) {
      return typeof nextRun === "number" && nowMs >= nextRun;
    }
    return false;
  }
  const next = job.state.nextRunAtMs;
  if (isErrorBackoffPending(params.state, job, nowMs)) {
    // Error retry windows are anchored at run end; persisted start-based
    // retry timestamps from older state must not bypass active backoff.
    return false;
  }
  if (hasScheduledNextRunAtMs(next) && nowMs >= next) {
    return true;
  }
  if (!params.allowCronMissedRunByLastRun || job.schedule.kind !== "cron") {
    return false;
  }
  let previousRunAtMs: number | undefined;
  try {
    previousRunAtMs = computeJobPreviousRunAtMs(job, nowMs);
  } catch {
    return false;
  }
  if (typeof previousRunAtMs !== "number" || !Number.isFinite(previousRunAtMs)) {
    return false;
  }
  const lastRunAtMs = job.state.lastRunAtMs;
  if (typeof lastRunAtMs !== "number" || !Number.isFinite(lastRunAtMs)) {
    // Only replay a "missed slot" when there is concrete run history.
    return false;
  }
  return previousRunAtMs > lastRunAtMs;
}

function isErrorBackoffPending(state: CronServiceState, job: CronJob, nowMs: number): boolean {
  if (job.schedule.kind === "at" || resolveJobLastRunStatus(job) !== "error") {
    return false;
  }
  const backoffUntilMs = resolveJobErrorBackoffUntilMs(
    job,
    state.deps.cronConfig?.retry?.backoffMs ?? DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  );
  return backoffUntilMs !== undefined && nowMs < backoffUntilMs;
}

function collectRunnableJobs(
  state: CronServiceState,
  nowMs: number,
  opts?: {
    skipJobIds?: ReadonlySet<string>;
    skipAtIfAlreadyRan?: boolean;
    allowCronMissedRunByLastRun?: boolean;
  },
): CronJob[] {
  if (!state.store) {
    return [];
  }
  return state.store.jobs.filter((job) =>
    isRunnableJob({
      state,
      job,
      nowMs,
      skipJobIds: opts?.skipJobIds,
      skipAtIfAlreadyRan: opts?.skipAtIfAlreadyRan,
      allowCronMissedRunByLastRun: opts?.allowCronMissedRunByLastRun,
    }),
  );
}

function deferPendingBackoffMissedCronSlots(
  state: CronServiceState,
  nowMs: number,
  opts?: { skipJobIds?: ReadonlySet<string> },
): boolean {
  if (!state.store) {
    return false;
  }
  let changed = false;
  for (const job of state.store.jobs) {
    if (
      !isJobEnabled(job) ||
      job.schedule.kind !== "cron" ||
      opts?.skipJobIds?.has(job.id) ||
      typeof job.state.runningAtMs === "number"
    ) {
      continue;
    }
    const backoffUntilMs = resolveJobErrorBackoffUntilMs(
      job,
      state.deps.cronConfig?.retry?.backoffMs ?? DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
    );
    if (backoffUntilMs === undefined || nowMs >= backoffUntilMs) {
      continue;
    }
    let previousRunAtMs: number | undefined;
    try {
      previousRunAtMs = computeJobPreviousRunAtMs(job, nowMs);
    } catch {
      continue;
    }
    const lastRunAtMs = job.state.lastRunAtMs;
    if (
      typeof previousRunAtMs !== "number" ||
      !Number.isFinite(previousRunAtMs) ||
      typeof lastRunAtMs !== "number" ||
      !Number.isFinite(lastRunAtMs) ||
      previousRunAtMs <= lastRunAtMs
    ) {
      continue;
    }
    if (job.state.nextRunAtMs !== backoffUntilMs) {
      job.state.nextRunAtMs = backoffUntilMs;
      changed = true;
    }
  }
  return changed;
}

/** Runs or defers missed startup jobs using restart catch-up limits. */
export async function runMissedJobs(
  state: CronServiceState,
  opts?: { skipJobIds?: ReadonlySet<string>; deferAgentTurnJobs?: boolean },
): Promise<void> {
  if (state.stopped) {
    return;
  }
  const plan = await planStartupCatchup(state, opts);
  if (plan.candidates.length === 0 && plan.deferredJobs.length === 0) {
    return;
  }

  const outcomes = await executeStartupCatchupPlan(state, plan);
  const finalizedOutcomes = await applyStartupCatchupOutcomes(state, plan, outcomes);
  for (const outcome of finalizedOutcomes) {
    maybeNotifyIsolatedAgentSetupTimeout(state, outcome);
  }
}

async function planStartupCatchup(
  state: CronServiceState,
  opts?: { skipJobIds?: ReadonlySet<string>; deferAgentTurnJobs?: boolean },
): Promise<StartupCatchupPlan> {
  const maxImmediate = Math.max(
    0,
    state.deps.maxMissedJobsPerRestart ?? DEFAULT_MAX_MISSED_JOBS_PER_RESTART,
  );
  return locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    if (state.stopped || !state.store) {
      return { candidates: [], deferredJobs: [] };
    }

    const now = state.deps.nowMs();
    const deferredBackoffMissedSlot = deferPendingBackoffMissedCronSlots(state, now, {
      skipJobIds: opts?.skipJobIds,
    });
    const missed = collectRunnableJobs(state, now, {
      skipJobIds: opts?.skipJobIds,
      skipAtIfAlreadyRan: true,
      allowCronMissedRunByLastRun: true,
    });
    if (missed.length === 0) {
      if (deferredBackoffMissedSlot) {
        await persist(state);
      }
      return { candidates: [], deferredJobs: [] };
    }
    const sorted = missed.toSorted(
      (a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0),
    );
    const deferredAgentJobs = opts?.deferAgentTurnJobs
      ? sorted.filter((job) => job.payload.kind === "agentTurn")
      : [];
    const startupEligible = opts?.deferAgentTurnJobs
      ? sorted.filter((job) => job.payload.kind !== "agentTurn")
      : sorted;
    const startupCandidates = startupEligible.slice(0, maxImmediate);
    const deferredOverflow = startupEligible.slice(maxImmediate);
    const deferredAgentDelayMs = Math.max(
      0,
      state.deps.startupDeferredMissedAgentJobDelayMs ??
        DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
    );
    // Agent-turn startup catch-up is deferred by default so gateway/channel
    // startup is not blocked by model/tool bootstrap work.
    const deferred: StartupDeferredJob[] = [
      ...deferredOverflow.map((job) => ({ jobId: job.id })),
      ...deferredAgentJobs.map((job) => ({ jobId: job.id, delayMs: deferredAgentDelayMs })),
    ];
    if (deferred.length > 0) {
      state.deps.log.info(
        {
          immediateCount: startupCandidates.length,
          deferredCount: deferred.length,
          totalMissed: missed.length,
        },
        "cron: staggering missed jobs to prevent gateway overload",
      );
    }
    if (deferredAgentJobs.length > 0) {
      state.deps.log.info(
        {
          count: deferredAgentJobs.length,
          jobIds: deferredAgentJobs.map((job) => job.id),
          delayMs: deferredAgentDelayMs,
        },
        "cron: deferring missed agent jobs until after gateway startup",
      );
    }
    if (startupCandidates.length > 0) {
      state.deps.log.info(
        { count: startupCandidates.length, jobIds: startupCandidates.map((j) => j.id) },
        "cron: running missed jobs after restart",
      );
    }
    for (const job of startupCandidates) {
      job.state.runningAtMs = now;
      job.state.lastError = undefined;
    }
    await persist(state);

    return {
      candidates: startupCandidates.map((job) => ({
        jobId: job.id,
        job,
        reservedAtMs: now,
      })),
      deferredJobs: deferred,
    };
  });
}

async function executeStartupCatchupPlan(
  state: CronServiceState,
  plan: StartupCatchupPlan,
): Promise<TimedCronRunOutcome[]> {
  const outcomes: TimedCronRunOutcome[] = [];
  for (const candidate of plan.candidates) {
    if (state.stopped) {
      break;
    }
    outcomes.push(await runStartupCatchupCandidate(state, candidate));
  }
  return outcomes;
}

async function runStartupCatchupCandidate(
  state: CronServiceState,
  candidate: StartupCatchupCandidate,
): Promise<TimedCronRunOutcome> {
  const startedAt = state.deps.nowMs();
  const taskRunId = tryCreateCronTaskRun({
    state,
    job: candidate.job,
    startedAt,
  });
  const activeJobMarker = markCronJobActive(candidate.job.id, {
    preserveAcrossGenerationAdvance: candidate.job.sessionTarget === "main",
  });
  emit(state, {
    jobId: candidate.job.id,
    action: "started",
    job: candidate.job,
    runAtMs: startedAt,
  });
  try {
    const result = await executeJobCoreWithTimeout(state, candidate.job, {
      runId: taskRunId,
      activeJobMarker,
    });
    return {
      jobId: candidate.jobId,
      job: candidate.job,
      taskRunId,
      activeJobMarker,
      status: result.status,
      error: result.error,
      summary: result.summary,
      diagnostics: result.diagnostics,
      delivered: result.delivered,
      sessionId: result.sessionId,
      sessionKey: result.sessionKey,
      model: result.model,
      provider: result.provider,
      usage: result.usage,
      isolatedAgentSetupTimeout: result.isolatedAgentSetupTimeout,
      // Quiet trigger ticks during startup catch-up must keep their eval
      // outcome; dropping it would record them as successful payload runs.
      triggerEval: result.triggerEval,
      startedAt,
      endedAt: state.deps.nowMs(),
    };
  } catch (err) {
    return {
      jobId: candidate.jobId,
      job: candidate.job,
      taskRunId,
      activeJobMarker,
      status: "error",
      error: normalizeCronRunErrorText(err),
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", normalizeCronRunErrorText(err), {
        nowMs: state.deps.nowMs,
      }),
      startedAt,
      endedAt: state.deps.nowMs(),
    };
  }
}

async function applyStartupCatchupOutcomes(
  state: CronServiceState,
  plan: StartupCatchupPlan,
  outcomes: TimedCronRunOutcome[],
): Promise<TimedCronRunOutcome[]> {
  const staggerMs = Math.max(0, state.deps.missedJobStaggerMs ?? DEFAULT_MISSED_JOB_STAGGER_MS);
  try {
    const currentOutcomes = filterCurrentCronRunOutcomes(outcomes);
    let finalizedOutcomes: TimedCronRunOutcome[] = [];
    await locked(state, async () => {
      await ensureLoaded(state, {
        forceReload: state.stopped,
        skipRecompute: true,
      });
      if (!state.store) {
        return;
      }
      if (state.stopped) {
        finishRetiredCronTaskRuns(state, outcomes, []);
        const releasedReservations = releaseUnstartedStartupCatchupReservations(
          state,
          plan,
          outcomes,
        );
        if (releasedReservations) {
          recomputeNextRunsForMaintenance(state, { repairFutureCronNextRunAtMs: false });
          await persist(state);
        }
        return;
      }

      finalizedOutcomes = filterCurrentCronRunOutcomes(currentOutcomes);
      finishRetiredCronTaskRuns(state, outcomes, finalizedOutcomes);
      const releasedReservations = releaseUnstartedStartupCatchupReservations(
        state,
        plan,
        outcomes,
      );
      for (const result of finalizedOutcomes) {
        applyOutcomeToStoredJob(state, result);
      }
      if (finalizedOutcomes.length === 0 && plan.deferredJobs.length === 0) {
        if (releasedReservations) {
          recomputeNextRunsForMaintenance(state, { repairFutureCronNextRunAtMs: false });
          await persist(state);
        }
        return;
      }

      if (plan.deferredJobs.length > 0) {
        const baseNow = state.deps.nowMs();
        let offset = staggerMs;
        for (const deferred of plan.deferredJobs) {
          const jobId = deferred.jobId;
          const job = state.store.jobs.find((entry) => entry.id === jobId);
          if (!job || !isJobEnabled(job)) {
            continue;
          }
          if (typeof deferred.delayMs === "number") {
            job.state.nextRunAtMs = baseNow + deferred.delayMs + offset - staggerMs;
            state.pendingCatchupDeferralJobIds.add(jobId);
            offset += staggerMs;
            continue;
          }
          job.state.nextRunAtMs = baseNow + offset;
          state.pendingCatchupDeferralJobIds.add(jobId);
          offset += staggerMs;
        }
      }

      // Preserve any new past-due nextRunAtMs values that became due while
      // startup catch-up was running. They should execute on a future tick
      // instead of being silently advanced. Future repair is disabled here so
      // startup overflow deferrals survive until their staggered catch-up tick.
      recomputeNextRunsForMaintenance(state, { repairFutureCronNextRunAtMs: false });
      await persist(state);
    });
    return finalizedOutcomes;
  } finally {
    clearActiveMarkersForOutcomes(outcomes);
  }
}

/** Executes a cron job without mutating persisted job state. */
export async function executeJobCore(
  state: CronServiceState,
  job: CronJob,
  abortSignal?: AbortSignal,
  options?: ExecuteJobCoreOptions,
): Promise<
  CronRunOutcome &
    CronRunTelemetry & {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      delivery?: CronDeliveryTrace;
      triggerEval?: CronTriggerEvalOutcome;
    }
> {
  const resolveAbortError = () => ({
    status: "error" as const,
    error: abortErrorMessage(abortSignal),
  });
  const waitWithAbort = async (ms: number) => {
    if (!abortSignal) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
      return;
    }
    if (abortSignal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  };

  if (abortSignal?.aborted) {
    return resolveAbortError();
  }
  let effectiveJob = job;
  let triggerEval: CronTriggerEvalOutcome | undefined;
  if (job.trigger) {
    const evaluator = state.deps.evaluateCronTrigger;
    if (!evaluator) {
      return { status: "error", error: "cron trigger evaluator is unavailable" };
    }
    const evaluation = await evaluator({
      job,
      script: job.trigger.script,
      state: job.state.triggerState,
      abortSignal,
    });
    if (evaluation.kind === "busy") {
      state.deps.log.debug({ jobId: job.id }, "cron: trigger evaluation skipped while busy");
      return {
        status: "ok",
        triggerEval: { fired: false, stateChanged: false, busy: true },
      };
    }
    if (evaluation.kind === "error") {
      return {
        status: "error",
        error: `cron trigger evaluation failed (${evaluation.code}): ${evaluation.error}`,
        triggerEval: { fired: false, stateChanged: false },
      };
    }
    const stateChanged = Object.hasOwn(evaluation, "state");
    triggerEval = {
      fired: evaluation.fire,
      stateChanged,
      ...(stateChanged ? { state: evaluation.state } : {}),
    };
    if (!evaluation.fire) {
      return { status: "ok", triggerEval };
    }
    if (evaluation.message !== undefined) {
      const payload =
        job.payload.kind === "systemEvent"
          ? { ...job.payload, text: `${job.payload.text}\n\n${evaluation.message}` }
          : job.payload.kind === "agentTurn"
            ? { ...job.payload, message: `${job.payload.message}\n\n${evaluation.message}` }
            : job.payload;
      effectiveJob = { ...job, payload };
    }
  }
  if (effectiveJob.sessionTarget === "main") {
    const result = await executeMainSessionCronJob(state, effectiveJob, abortSignal, waitWithAbort);
    return triggerEval ? { ...result, triggerEval } : result;
  }

  const result = await executeDetachedCronJob(
    state,
    effectiveJob,
    abortSignal,
    resolveAbortError,
    options,
  );
  return triggerEval ? { ...result, triggerEval } : result;
}

async function executeMainSessionCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal: AbortSignal | undefined,
  waitWithAbort: (ms: number) => Promise<void>,
): Promise<
  CronRunOutcome &
    CronRunTelemetry & {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      delivery?: CronDeliveryTrace;
    }
> {
  const text = resolveJobPayloadTextForMain(job);
  if (!text) {
    const kind = job.payload.kind;
    return {
      status: "skipped",
      error:
        kind === "systemEvent"
          ? "main job requires non-empty systemEvent text"
          : 'main job requires payload.kind="systemEvent"',
    };
  }
  const cronStartedAt =
    typeof job.state.runningAtMs === "number" ? job.state.runningAtMs : state.deps.nowMs();
  const cronRunSessionKey = resolveMainSessionCronRunSessionKey(job, cronStartedAt);
  const deliveryContext = resolveMainSessionCronDeliveryContext(state, job);
  // Main-session jobs enqueue text into a per-run child session so each cron
  // execution has its own transcript and task drill-down target.
  const queuedSystemEvent = normalizeQueuedSystemEventHandle(
    state.deps.enqueueSystemEvent(text, {
      agentId: job.agentId,
      sessionKey: cronRunSessionKey,
      contextKey: `cron:${job.id}`,
      ...(deliveryContext ? { deliveryContext } : {}),
    }),
  );
  if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
    const reason = `cron:${job.id}`;
    const maxWaitMs = state.deps.wakeNowHeartbeatBusyMaxWaitMs ?? 2 * 60_000;
    const retryDelayMs = state.deps.wakeNowHeartbeatBusyRetryDelayMs ?? 250;
    const waitStartedAt = state.deps.nowMs();

    let heartbeatResult: HeartbeatRunResult;
    for (;;) {
      if (abortSignal?.aborted) {
        removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
        return { status: "error", error: timeoutErrorMessage() };
      }
      heartbeatResult = await state.deps.runHeartbeatOnce({
        source: "cron",
        intent: "immediate",
        reason,
        agentId: job.agentId,
        sessionKey: cronRunSessionKey,
        heartbeat: { target: "last" },
      });
      if (abortSignal?.aborted) {
        removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
        return { status: "error", error: timeoutErrorMessage() };
      }
      if (
        heartbeatResult.status !== "skipped" ||
        !isRetryableHeartbeatBusySkipReason(heartbeatResult.reason)
      ) {
        break;
      }
      if (heartbeatResult.reason === HEARTBEAT_SKIP_CRON_IN_PROGRESS) {
        // The active cron marker blocks direct wake-now until this job returns.
        state.deps.requestHeartbeat({
          source: "cron",
          intent: "immediate",
          reason,
          agentId: job.agentId,
          sessionKey: cronRunSessionKey,
          heartbeat: { target: "last" },
        });
        return { status: "ok", summary: text, sessionKey: cronRunSessionKey };
      }
      if (abortSignal?.aborted) {
        removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
        return { status: "error", error: timeoutErrorMessage() };
      }
      if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
        if (abortSignal?.aborted) {
          removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
          return { status: "error", error: timeoutErrorMessage() };
        }
        state.deps.requestHeartbeat({
          source: "cron",
          intent: "immediate",
          reason,
          agentId: job.agentId,
          sessionKey: cronRunSessionKey,
          heartbeat: { target: "last" },
        });
        return { status: "ok", summary: text, sessionKey: cronRunSessionKey };
      }
      await waitWithAbort(retryDelayMs);
    }

    if (heartbeatResult.status === "ran") {
      return { status: "ok", summary: text, sessionKey: cronRunSessionKey };
    }
    if (heartbeatResult.status === "skipped") {
      removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
      return {
        status: "skipped",
        error: heartbeatResult.reason,
        summary: text,
        sessionKey: cronRunSessionKey,
      };
    }
    removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
    return {
      status: "error",
      error: heartbeatResult.reason,
      summary: text,
      sessionKey: cronRunSessionKey,
    };
  }

  if (abortSignal?.aborted) {
    removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
    return { status: "error", error: timeoutErrorMessage() };
  }
  state.deps.requestHeartbeat({
    source: "cron",
    intent: job.wakeMode === "now" ? "immediate" : "event",
    reason: `cron:${job.id}`,
    agentId: job.agentId,
    sessionKey: cronRunSessionKey,
    heartbeat: { target: "last" },
  });
  return { status: "ok", summary: text, sessionKey: cronRunSessionKey };
}

async function executeDetachedCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal: AbortSignal | undefined,
  resolveAbortError: () => { status: "error"; error: string },
  options?: ExecuteJobCoreOptions,
): Promise<
  CronRunOutcome &
    CronRunTelemetry & {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      delivery?: CronDeliveryTrace;
    }
> {
  if (job.payload.kind === "command") {
    if (!state.deps.runCommandJob) {
      const error = "cron command runner is not configured";
      return {
        status: "skipped",
        error,
        diagnostics: createCronRunDiagnosticsFromError("cron-preflight", error, {
          severity: "warn",
          nowMs: state.deps.nowMs,
        }),
      };
    }
    const res = await state.deps.runCommandJob({
      job,
      abortSignal,
    });
    if (abortSignal?.aborted) {
      const error = abortErrorMessage(abortSignal);
      return {
        status: "error",
        error,
        diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
          nowMs: state.deps.nowMs,
        }),
      };
    }
    return {
      status: res.status,
      error: res.error,
      summary: res.summary,
      delivered: res.delivered,
      deliveryAttempted: res.deliveryAttempted,
      delivery: res.delivery,
      diagnostics: res.diagnostics,
    };
  }

  if (job.payload.kind !== "agentTurn") {
    const error = 'isolated job requires payload.kind="agentTurn" or "command"';
    return {
      status: "skipped",
      error,
      diagnostics: createCronRunDiagnosticsFromError("cron-preflight", error, {
        severity: "warn",
        nowMs: state.deps.nowMs,
      }),
    };
  }
  if (abortSignal?.aborted) {
    const aborted = resolveAbortError();
    return {
      ...aborted,
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", aborted.error, {
        nowMs: state.deps.nowMs,
      }),
    };
  }

  const res = await state.deps.runIsolatedAgentJob({
    job,
    message: job.payload.message,
    abortSignal,
    onExecutionStarted: options?.onExecutionStarted,
    onExecutionPhase: options?.onExecutionPhase,
    onLaneWait: options?.onLaneWait,
  });

  if (abortSignal?.aborted) {
    const error = abortErrorMessage(abortSignal);
    return {
      status: "error",
      error,
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
        nowMs: state.deps.nowMs,
      }),
    };
  }

  return {
    status: res.status,
    error: res.error,
    summary: res.summary,
    delivered: res.delivered,
    deliveryAttempted: res.deliveryAttempted,
    delivery: res.delivery,
    sessionId: res.sessionId,
    sessionKey: res.sessionKey,
    diagnostics: res.diagnostics,
    model: res.model,
    provider: res.provider,
    usage: res.usage,
  };
}

function emitJobFinished(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: CronRunStatus;
    delivered?: boolean;
    delivery?: CronDeliveryTrace;
    triggerEval?: CronTriggerEvalOutcome;
  } & CronRunOutcome &
    CronRunTelemetry,
  runAtMs: number,
) {
  emit(state, {
    jobId: job.id,
    action: "finished",
    job,
    status: result.status,
    error: result.error,
    summary: result.summary,
    diagnostics: result.diagnostics,
    delivered: job.state.lastDelivered,
    deliveryStatus: job.state.lastDeliveryStatus,
    deliveryError: job.state.lastDeliveryError,
    failureNotificationDelivery: failureNotificationDeliveryFromJobState(job),
    delivery: result.delivery,
    sessionId: result.sessionId,
    sessionKey: result.sessionKey,
    runAtMs,
    durationMs: job.state.lastDurationMs,
    nextRunAtMs: job.state.nextRunAtMs,
    ...(result.triggerEval?.fired ? { triggerFired: true } : {}),
    model: result.model,
    provider: result.provider,
    usage: result.usage,
  });
}

/** Clears the currently armed cron timer. */
export function stopTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
}
