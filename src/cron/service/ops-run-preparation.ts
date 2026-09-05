import type { CommandLaneTaskMarker } from "../../process/command-queue.js";
import type { CronActiveJobMarker } from "../active-jobs.js";
import { resolveCronCompletionStatus } from "../completion-status.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import {
  finishCronRunReceiptInDatabase,
  releaseLocalCronRunReceiptOwnership,
  type CronRunReceiptHandle,
} from "../store/run-receipt-store.js";
import type {
  CronFailureNotificationDetail,
  CronJob,
  CronPayload,
  CronRunErrorClassification,
} from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { findJobOrThrow, hasActiveCronRun, isJobDue, isJobEnabled } from "./jobs-scheduling.js";
import { assertSupportedJobSpec } from "./jobs-validation.js";
import { locked } from "./locked.js";
import { markManualCronJobActive, ownsStreamSource } from "./ops-shared.js";
import {
  activateQueuedCronRun,
  cleanupQueuedCronRunReservations,
  isQueuedCronRunReservationCurrent,
  persistQueuedCronRunReservations,
  releaseQueuedCronRun,
  reserveQueuedCronRun,
} from "./run-admission.js";
import { recomputeUnownedCronSchedules } from "./run-recovery.js";
import { applyCronRuntimeRowsToState, commitCronRuntimeRows } from "./runtime-store.js";
import type {
  CronEvent,
  CronRunMode,
  CronServiceState,
  DeferredCronNotifications,
} from "./state.js";
import { cronFailureNotificationEventContext, emit, isImmediateCronRunMode } from "./state.js";
import { ensureLoaded, runPostPersistCronNotifications, warnIfDisabled } from "./store.js";
import { tryCreateCronTaskRunHandle, tryFinishCronTaskRun } from "./task-runs.js";
import { applyJobResult, armTimer, type CronTriggerEvalOutcome } from "./timer.js";

type PreparedManualRun =
  | {
      ok: true;
      ran: false;
      reason: "already-running" | "disabled" | "not-due" | "invalid-spec" | "stopped";
    }
  | {
      ok: true;
      ran: true;
      jobId: string;
      runId?: string;
      terminalTracker?: ManualRunTerminalTracker;
      owningCronLaneTaskMarker?: CommandLaneTaskMarker;
      reservationAt: number;
      scheduleOwnershipAtMs: number;
      reservationIdentity: object;
      wasEnabled: boolean;
      payload?: CronPayload;
      evaluateTrigger?: boolean;
      streamBatch?: string;
      streamScheduleKey?: string;
      streamSourceIdentity?: string;
      onTriggerDisposition?: (disposition: "fired" | "dropped" | "busy" | "error") => void;
    }
  | { ok: false };

export type ActivatedManualRun = Extract<PreparedManualRun, { ran: true }> & {
  startedAt: number;
  taskRunId?: string;
  taskId?: string;
  flowId?: string;
  activeJobMarker?: CronActiveJobMarker;
  admittedJob: CronJob;
  executionJob: CronJob;
  runReceipt: CronRunReceiptHandle;
};

export type ManualRunOptions = {
  runId?: string;
  /** Revalidates the caller before preflight effects and durable reservation. */
  commitGuard?: () => void;
  scheduleOwnershipAtMs?: number;
  payload?: CronPayload;
  terminalTracker?: ManualRunTerminalTracker;
  owningCronLaneTaskMarker?: CommandLaneTaskMarker;
  evaluateTrigger?: boolean;
  streamBatch?: string;
  streamScheduleKey?: string;
  streamSourceIdentity?: string;
  onTriggerDisposition?: (disposition: "fired" | "dropped" | "busy" | "error") => void;
};

export type ManualRunTerminalTracker = { emitted: boolean };

export function emitCronRunFinished(
  state: CronServiceState,
  evt: CronEvent & { action: "finished" },
  tracker?: ManualRunTerminalTracker,
  taskRunId?: string,
  details?: {
    triggerEval?: CronTriggerEvalOutcome;
    scriptResult?: { scriptStateChanged?: boolean; scriptState?: unknown };
    errorClassification?: CronRunErrorClassification;
    failureNotificationDetail?: CronFailureNotificationDetail;
  },
): void {
  const event = {
    ...evt,
    completionStatus:
      evt.completionStatus ??
      resolveCronCompletionStatus({ status: evt.status, deliveryStatus: evt.deliveryStatus }),
  };
  tryFinishCronTaskRun(state, {
    taskRunId,
    job: evt.job,
    event,
    errorClassification: details?.errorClassification,
    ...(details?.scriptResult ? { scriptResult: details.scriptResult } : {}),
    ...(details?.triggerEval ? { triggerEval: details.triggerEval } : {}),
  });
  emit(state, event, cronFailureNotificationEventContext(details?.failureNotificationDetail));
  if (tracker) {
    tracker.emitted = true;
  }
}

type ManualRunDisposition =
  | Extract<PreparedManualRun, { ran: false }>
  | { ok: true; runnable: true };

type ManualRunPreflightResult =
  | { ok: false }
  | Extract<PreparedManualRun, { ran: false }>
  | {
      ok: true;
      runnable: true;
      job: CronJob;
    };

function admitsStreamSourceRun(
  job: CronJob,
  streamScheduleKey?: string,
  streamSourceIdentity?: string,
): boolean {
  if (streamScheduleKey === undefined && streamSourceIdentity === undefined) {
    return true;
  }
  return (
    streamScheduleKey !== undefined &&
    streamSourceIdentity !== undefined &&
    isJobEnabled(job) &&
    ownsStreamSource(job, streamScheduleKey, streamSourceIdentity)
  );
}

function skipInvalidPersistedManualRun(params: {
  state: CronServiceState;
  job: CronJob;
  mode?: CronRunMode;
  runId?: string;
  terminalTracker?: ManualRunTerminalTracker;
  error: unknown;
}) {
  const postPersistNotifications: DeferredCronNotifications = [];
  const endedAt = params.state.deps.nowMs();
  const errorText = normalizeCronRunErrorText(params.error);
  const diagnostics = createCronRunDiagnosticsFromError("cron-preflight", errorText, {
    severity: "warn",
    nowMs: params.state.deps.nowMs,
  });
  // Applying the outcome may disable a one-shot; compare the original definition.
  const configRevision = resolveCronJobConfigRevision(params.job);
  applyJobResult(
    params.state,
    params.job,
    {
      status: "skipped",
      completionStatus: "failed",
      error: errorText,
      diagnostics,
      startedAt: endedAt,
      endedAt,
    },
    {
      scheduleMode: isImmediateCronRunMode(params.mode) ? "preserve" : "advance",
      deferredNotifications: postPersistNotifications,
    },
  );

  const committedJob = commitCronRuntimeRows({
    state: params.state,
    jobIds: [params.job.id],
    operationLabel: "cron.invalid-manual-run",
    mutate: ({ jobs }) => {
      const current = jobs.get(params.job.id);
      if (!current || resolveCronJobConfigRevision(current) !== configRevision) {
        return { value: undefined };
      }
      current.enabled = params.job.enabled;
      current.updatedAtMs = params.job.updatedAtMs;
      current.state = structuredClone(params.job.state);
      return { upsertJobIds: [current.id], value: current };
    },
  });
  if (!committedJob) {
    armTimer(params.state);
    return;
  }
  // Subscribers may close caller authority or edit the job synchronously.
  // Publish only after the terminal state is durably committed.
  applyCronRuntimeRowsToState(params.state, [committedJob]);
  emitCronRunFinished(
    params.state,
    {
      jobId: params.job.id,
      action: "finished",
      job: params.job,
      status: "skipped",
      error: errorText,
      diagnostics,
      runId: params.runId,
      runAtMs: endedAt,
      durationMs: params.job.state.lastDurationMs,
      nextRunAtMs: params.job.state.nextRunAtMs,
      deliveryStatus: params.job.state.lastDeliveryStatus,
      deliveryError: params.job.state.lastDeliveryError,
      failureNotificationDelivery: failureNotificationDeliveryFromJobState(params.job),
    },
    params.terminalTracker,
  );
  runPostPersistCronNotifications(params.state, postPersistNotifications);
  armTimer(params.state);
}

function recomputeManualRunPreflight(state: CronServiceState, id: string, mode?: CronRunMode) {
  const maintenance = recomputeUnownedCronSchedules(state, {
    ...(isImmediateCronRunMode(mode) ? { preserveExpiredPacedNextRunJobId: id } : {}),
    skipScheduleErrorHandling: true,
  });
  runPostPersistCronNotifications(state, maintenance.notifications);
  applyCronRuntimeRowsToState(state, maintenance.jobs);
}

// The caller holds the store lock through preflight and any reservation.
async function inspectManualRunPreflight(
  state: CronServiceState,
  id: string,
  mode?: CronRunMode,
  opts?: ManualRunOptions,
): Promise<ManualRunPreflightResult> {
  warnIfDisabled(state, "run");
  await ensureLoaded(state, { skipRecompute: true });
  opts?.commitGuard?.();
  if (state.stopped) {
    return { ok: true, ran: false, reason: "stopped" };
  }
  // Normalize stale tick state before eligibility checks (#17554). Revalidate
  // after notifications too: synchronous owner callbacks can close the caller.
  recomputeManualRunPreflight(state, id, mode);
  opts?.commitGuard?.();
  const job = findJobOrThrow(state, id);
  if (mode === "if-enabled" && (!isJobEnabled(job) || job.state.autoDisabled)) {
    return { ok: true, ran: false, reason: "disabled" };
  }
  if (!admitsStreamSourceRun(job, opts?.streamScheduleKey, opts?.streamSourceIdentity)) {
    return { ok: true, ran: false, reason: "not-due" };
  }
  try {
    assertSupportedJobSpec(job);
  } catch (error) {
    skipInvalidPersistedManualRun({
      state,
      job,
      mode,
      runId: opts?.runId,
      terminalTracker: opts?.terminalTracker,
      error,
    });
    return { ok: true, ran: false, reason: "invalid-spec" };
  }
  if (hasActiveCronRun(job)) {
    return { ok: true, ran: false, reason: "already-running" };
  }
  const now = state.deps.nowMs();
  if (!isJobDue(job, now, { forced: isImmediateCronRunMode(mode) })) {
    return { ok: true, ran: false, reason: "not-due" };
  }
  return { ok: true, runnable: true, job };
}

export async function inspectManualRunDisposition(
  state: CronServiceState,
  id: string,
  mode?: CronRunMode,
  opts?: Pick<ManualRunOptions, "commitGuard">,
): Promise<ManualRunDisposition | { ok: false }> {
  // Queue callers need a cheap eligibility check before entering the command
  // lane; the real reservation happens later under lock in prepareManualRun.
  const result = await locked(state, () => inspectManualRunPreflight(state, id, mode, opts));
  if (!result.ok) {
    return result;
  }
  if ("reason" in result) {
    return result;
  }
  return { ok: true, runnable: true } as const;
}

export async function prepareManualRun(
  state: CronServiceState,
  id: string,
  mode?: CronRunMode,
  opts?: ManualRunOptions,
): Promise<PreparedManualRun> {
  return await locked(state, async () => {
    const preflight = await inspectManualRunPreflight(state, id, mode, opts);
    if (!preflight.ok || "reason" in preflight) {
      return preflight;
    }
    const { job } = preflight;
    // Preflight awaited store loading; keep the exact caller live until the
    // synchronous reservation write transfers ownership to its durable receipt.
    opts?.commitGuard?.();
    const reservationAt = state.deps.nowMs();
    if (!isJobDue(job, reservationAt, { forced: isImmediateCronRunMode(mode) })) {
      return { ok: true, ran: false, reason: "not-due" as const };
    }
    // Persist the queued marker before releasing lock so timer ticks that
    // force-reload from disk cannot start the same job concurrently.
    const [reserved] = await persistQueuedCronRunReservations({
      state,
      candidates: [job],
      ...(isImmediateCronRunMode(mode) ? { immediateJobIds: new Set([job.id]) } : {}),
      reservedAtMs: reservationAt,
    });
    if (!reserved) {
      return { ok: true, ran: false, reason: "already-running" as const };
    }
    const reservedJob = reserved.job;
    const reservationIdentity = reserveQueuedCronRun(state, reservedJob.id, reservationAt, {
      runReceipt: reserved.runReceipt,
      preserveWhenDisabled: mode === "force" && !isJobEnabled(job),
    });
    if (state.stopped) {
      try {
        await releasePreparedManualReservationWithRetry(state, {
          jobId: reservedJob.id,
          reservationIdentity,
        });
      } catch (error) {
        releaseQueuedCronRun(state, job.id, reservationIdentity);
        throw error;
      }
      return { ok: true, ran: false, reason: "stopped" as const };
    }
    return {
      ok: true,
      ran: true,
      jobId: reservedJob.id,
      runId: opts?.runId,
      terminalTracker: opts?.terminalTracker,
      owningCronLaneTaskMarker: opts?.owningCronLaneTaskMarker,
      reservationAt,
      scheduleOwnershipAtMs: opts?.scheduleOwnershipAtMs ?? reservationAt,
      reservationIdentity,
      wasEnabled: isJobEnabled(job),
      ...(opts?.payload ? { payload: structuredClone(opts.payload) } : {}),
      ...(opts?.evaluateTrigger ? { evaluateTrigger: true } : {}),
      ...(opts?.streamBatch !== undefined ? { streamBatch: opts.streamBatch } : {}),
      ...(opts?.streamScheduleKey !== undefined
        ? { streamScheduleKey: opts.streamScheduleKey }
        : {}),
      ...(opts?.streamSourceIdentity !== undefined
        ? { streamSourceIdentity: opts.streamSourceIdentity }
        : {}),
      ...(opts?.onTriggerDisposition ? { onTriggerDisposition: opts.onTriggerDisposition } : {}),
    } as const;
  });
}

export async function activatePreparedManualRun(
  state: CronServiceState,
  prepared: Extract<PreparedManualRun, { ran: true }>,
  mode?: CronRunMode,
): Promise<ActivatedManualRun | Extract<PreparedManualRun, { ran: false }>> {
  return await locked(state, async () => {
    // Reservations can wait behind another cron run. Reload under the service
    // lock so disabling, rescheduling, or removing the job wins that wait.
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    if (state.stopped) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "stopped" } as const;
    }
    const job = state.store?.jobs.find((entry) => entry.id === prepared.jobId);
    if (!job) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "not-due" } as const;
    }
    if (
      !isQueuedCronRunReservationCurrent(state, prepared.jobId, prepared.reservationIdentity) ||
      job.state.queuedAtMs !== prepared.reservationAt
    ) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "not-due" } as const;
    }
    if (mode === "if-enabled" && (!isJobEnabled(job) || job.state.autoDisabled)) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "disabled" } as const;
    }
    if (!admitsStreamSourceRun(job, prepared.streamScheduleKey, prepared.streamSourceIdentity)) {
      // This is reservation identity, not watcher ownership: a force run can
      // wait behind cron admission after its owner has stopped for replacement.
      // The logical source identity rejects retired batches even when the
      // schedule key is unchanged (disable→re-enable, A→B→A).
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "not-due" } as const;
    }
    const dueProbe = structuredClone(job);
    delete dueProbe.state.queuedAtMs;
    if (
      (prepared.wasEnabled && !isJobEnabled(job)) ||
      !isJobDue(dueProbe, state.deps.nowMs(), { forced: isImmediateCronRunMode(mode) })
    ) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "not-due" } as const;
    }
    try {
      assertSupportedJobSpec(job);
    } catch (error) {
      skipInvalidPersistedManualRun({
        state,
        job,
        mode,
        runId: prepared.runId,
        terminalTracker: prepared.terminalTracker,
        error,
      });
      releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
      return { ok: true, ran: false, reason: "invalid-spec" } as const;
    }

    const activation = await activateQueuedCronRun({
      state,
      job,
      reservationIdentity: prepared.reservationIdentity,
      onUnavailableRollbackError: async () => {
        await releasePreparedManualReservationWithRetry(state, prepared);
      },
    });
    if (activation.kind === "unavailable") {
      return { ok: true, ran: false, reason: activation.reason } as const;
    }
    if (activation.kind === "fenced") {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "already-running" } as const;
    }
    const { job: activatedJob, startedAt } = activation;
    emit(state, {
      jobId: activatedJob.id,
      action: "started",
      job: activatedJob,
      runAtMs: startedAt,
    });
    const taskRun = tryCreateCronTaskRunHandle({
      state,
      job: activatedJob,
      startedAt,
      runReceipt: activation.runReceipt,
      publicRunId: prepared.runId,
    });
    const taskRunId = taskRun?.runId;
    const activeJobMarker = markManualCronJobActive(state, job);
    // Execute against a snapshot so later reload/merge can preserve delivery
    // target writeback from disk without mutating the running object.
    const admittedJob = structuredClone(activatedJob);
    const executionJob = structuredClone(activatedJob);
    if (isImmediateCronRunMode(mode) && executionJob.trigger && !prepared.evaluateTrigger) {
      // Immediate modes run the payload now; strip the gate only from this snapshot
      // so persisted trigger state and future due evaluations stay intact.
      delete executionJob.trigger;
    }
    if (prepared.payload) {
      executionJob.payload = structuredClone(prepared.payload);
    }
    return {
      ...prepared,
      startedAt,
      runId: prepared.runId ?? taskRunId,
      taskRunId,
      taskId: taskRun?.taskId,
      flowId: taskRun?.flowId,
      activeJobMarker,
      admittedJob,
      executionJob,
      runReceipt: activation.runReceipt,
    } as const;
  });
}

async function releasePreparedManualReservation(
  state: CronServiceState,
  prepared: Pick<Extract<PreparedManualRun, { ran: true }>, "jobId" | "reservationIdentity">,
): Promise<void> {
  if (
    state.queuedRunReservationsByJobId.get(prepared.jobId)?.identity !==
    prepared.reservationIdentity
  ) {
    return;
  }
  const committedJob = commitCronRuntimeRows({
    state,
    jobIds: [prepared.jobId],
    operationLabel: "cron.manual-reservation-cleanup",
    mutate: ({ database, jobs }) => {
      const job = jobs.get(prepared.jobId);
      const ownership = state.queuedRunReservationsByJobId.get(prepared.jobId);
      if (ownership?.identity !== prepared.reservationIdentity) {
        return { value: undefined };
      }
      finishCronRunReceiptInDatabase({
        database,
        handle: ownership.runReceipt,
        status: "skipped",
        finishedAtMs: state.deps.nowMs(),
        error: "cron manual reservation abandoned before completion",
      });
      if (!job) {
        return { value: undefined };
      }
      const queuedMatches = ownership.markerAtMs === job.state.queuedAtMs;
      const runningMatches = ownership.markerAtMs === job.state.runningAtMs;
      if (!queuedMatches && !runningMatches) {
        return { value: undefined };
      }
      if (ownership.activationPreviousLastError) {
        job.state.lastError = ownership.activationPreviousLastError.value;
      }
      if (queuedMatches) {
        delete job.state.queuedAtMs;
      }
      if (runningMatches) {
        delete job.state.runningAtMs;
      }
      return { upsertJobIds: [job.id], value: job };
    },
  });
  if (committedJob) {
    applyCronRuntimeRowsToState(state, [committedJob]);
  }
  const ownership = state.queuedRunReservationsByJobId.get(prepared.jobId);
  if (ownership?.identity === prepared.reservationIdentity) {
    releaseLocalCronRunReceiptOwnership(ownership.runReceipt);
  }
  releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
}

export async function releasePreparedManualReservationWithRetry(
  state: CronServiceState,
  prepared: Pick<Extract<PreparedManualRun, { ran: true }>, "jobId" | "reservationIdentity">,
): Promise<void> {
  try {
    await releasePreparedManualReservation(state, prepared);
  } catch {
    try {
      await releasePreparedManualReservation(state, prepared);
    } catch (error) {
      // No caller owns another retry. Let stale-marker recovery see the
      // durable marker instead of retaining a process-only queued claim.
      const ownership = state.queuedRunReservationsByJobId.get(prepared.jobId);
      if (ownership?.identity === prepared.reservationIdentity) {
        releaseLocalCronRunReceiptOwnership(ownership.runReceipt);
      }
      releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
      throw error;
    }
  }
}

export async function releasePreparedManualReservationAfterReloadWithRetry(
  state: CronServiceState,
  prepared: Extract<PreparedManualRun, { ran: true }>,
): Promise<void> {
  await cleanupQueuedCronRunReservations({
    state,
    reservations: [prepared],
    restoreLastError: false,
  });
}
