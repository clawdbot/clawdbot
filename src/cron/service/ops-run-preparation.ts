import type { CommandLaneTaskMarker } from "../../process/command-queue.js";
import type { CronActiveJobMarker } from "../active-jobs.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import type { CronJob, CronPayload, CronRunErrorClassification } from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import {
  assertSupportedJobSpec,
  findJobOrThrow,
  hasActiveCronRun,
  isJobDue,
  isJobEnabled,
  recomputeNextRunsForMaintenance,
} from "./jobs.js";
import { locked } from "./locked.js";
import { markManualCronJobActive, ownsStreamSource } from "./ops-shared.js";
import {
  clearQueuedCronRunReservationMarker,
  isQueuedCronRunReservationCurrent,
  isQueuedCronRunReservationMarkerCurrent,
  releaseQueuedCronRun,
  reserveQueuedCronRun,
  updateQueuedCronRunReservationMarker,
} from "./run-admission.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { emit } from "./state.js";
import {
  ensureLoaded,
  persistOrRestore,
  snapshotStoreForRollback,
  warnIfDisabled,
} from "./store.js";
import { tryCreateCronTaskRun, tryFinishCronTaskRun } from "./task-runs.js";
import { applyJobResult, armTimer, type CronTriggerEvalOutcome } from "./timer.js";

type PreparedManualRun =
  | {
      ok: true;
      ran: false;
      reason:
        | "already-running"
        | "not-due"
        | "invalid-spec"
        | "restart-recovery-pending"
        | "stopped";
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
  activeJobMarker?: CronActiveJobMarker;
  admittedJob: CronJob;
  executionJob: CronJob;
};

export type ManualRunOptions = {
  runId?: string;
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
  },
): void {
  tryFinishCronTaskRun(state, {
    taskRunId,
    job: evt.job,
    event: evt,
    errorClassification: details?.errorClassification,
    ...(details?.scriptResult ? { scriptResult: details.scriptResult } : {}),
    ...(details?.triggerEval ? { triggerEval: details.triggerEval } : {}),
  });
  emit(state, evt);
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
      now: number;
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

async function skipInvalidPersistedManualRun(params: {
  state: CronServiceState;
  job: CronJob;
  mode?: "due" | "force";
  runId?: string;
  terminalTracker?: ManualRunTerminalTracker;
  error: unknown;
}) {
  const rollbackSnapshot = snapshotStoreForRollback(params.state);
  const endedAt = params.state.deps.nowMs();
  const errorText = normalizeCronRunErrorText(params.error);
  const diagnostics = createCronRunDiagnosticsFromError("cron-preflight", errorText, {
    severity: "warn",
    nowMs: params.state.deps.nowMs,
  });
  applyJobResult(
    params.state,
    params.job,
    {
      status: "skipped",
      error: errorText,
      diagnostics,
      startedAt: endedAt,
      endedAt,
    },
    { scheduleMode: params.mode === "force" ? "preserve" : "advance" },
  );

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

  recomputeNextRunsForMaintenance(params.state, {
    recomputeExpired: true,
    ...(params.mode === "force"
      ? {
          preserveExpiredPacedNextRunJobId: params.job.id,
        }
      : {}),
  });
  await persistOrRestore(params.state, rollbackSnapshot);
  armTimer(params.state);
}

async function inspectManualRunPreflight(
  state: CronServiceState,
  id: string,
  mode?: "due" | "force",
  runId?: string,
  terminalTracker?: ManualRunTerminalTracker,
  streamScheduleKey?: string,
  streamSourceIdentity?: string,
): Promise<ManualRunPreflightResult> {
  return await locked(state, async () => {
    warnIfDisabled(state, "run");
    await ensureLoaded(state, { skipRecompute: true });
    if (state.stopped) {
      return { ok: true, ran: false, reason: "stopped" } as const;
    }
    if (state.restartRecoveryPending) {
      return { ok: true, ran: false, reason: "restart-recovery-pending" } as const;
    }
    // Normalize job tick state (clears stale runningAtMs markers) before
    // checking if already running, so a stale marker from a crashed Phase-1
    // persist does not block manual triggers for up to STUCK_RUN_MS (#17554).
    recomputeNextRunsForMaintenance(
      state,
      mode === "force" ? { preserveExpiredPacedNextRunJobId: id } : undefined,
    );
    const job = findJobOrThrow(state, id);
    if (!admitsStreamSourceRun(job, streamScheduleKey, streamSourceIdentity)) {
      return { ok: true, ran: false, reason: "not-due" } as const;
    }
    try {
      assertSupportedJobSpec(job);
    } catch (error) {
      await skipInvalidPersistedManualRun({ state, job, mode, runId, terminalTracker, error });
      return { ok: true, ran: false, reason: "invalid-spec" as const };
    }
    if (hasActiveCronRun(job)) {
      return { ok: true, ran: false, reason: "already-running" as const };
    }
    const now = state.deps.nowMs();
    const due = isJobDue(job, now, { forced: mode === "force" });
    if (!due) {
      return { ok: true, ran: false, reason: "not-due" } as const;
    }
    return { ok: true, runnable: true, job, now } as const;
  });
}

export async function inspectManualRunDisposition(
  state: CronServiceState,
  id: string,
  mode?: "due" | "force",
): Promise<ManualRunDisposition | { ok: false }> {
  // Queue callers need a cheap eligibility check before entering the command
  // lane; the real reservation happens later under lock in prepareManualRun.
  const result = await inspectManualRunPreflight(state, id, mode);
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
  mode?: "due" | "force",
  opts?: ManualRunOptions,
): Promise<PreparedManualRun> {
  const preflight = await inspectManualRunPreflight(
    state,
    id,
    mode,
    opts?.runId,
    opts?.terminalTracker,
    opts?.streamScheduleKey,
    opts?.streamSourceIdentity,
  );
  if (!preflight.ok) {
    return preflight;
  }
  if ("reason" in preflight) {
    return {
      ok: true,
      ran: false,
      reason: preflight.reason,
    } as const;
  }
  return await locked(state, async () => {
    // Reserve this run under lock, then execute outside lock so read ops
    // (`list`, `status`) stay responsive while the run is in progress.
    if (state.stopped) {
      return { ok: true, ran: false, reason: "stopped" as const };
    }
    if (state.restartRecoveryPending) {
      return { ok: true, ran: false, reason: "restart-recovery-pending" as const };
    }
    // The initial preflight is advisory. A command-lane wait or another cron
    // run can change this job before its reservation is persisted.
    await ensureLoaded(state, { skipRecompute: true });
    recomputeNextRunsForMaintenance(
      state,
      mode === "force" ? { preserveExpiredPacedNextRunJobId: id } : undefined,
    );
    const job = findJobOrThrow(state, id);
    if (!admitsStreamSourceRun(job, opts?.streamScheduleKey, opts?.streamSourceIdentity)) {
      return { ok: true, ran: false, reason: "not-due" as const };
    }
    try {
      assertSupportedJobSpec(job);
    } catch (error) {
      await skipInvalidPersistedManualRun({
        state,
        job,
        mode,
        runId: opts?.runId,
        terminalTracker: opts?.terminalTracker,
        error,
      });
      return { ok: true, ran: false, reason: "invalid-spec" as const };
    }
    if (hasActiveCronRun(job)) {
      return { ok: true, ran: false, reason: "already-running" as const };
    }
    const reservationAt = state.deps.nowMs();
    if (!isJobDue(job, reservationAt, { forced: mode === "force" })) {
      return { ok: true, ran: false, reason: "not-due" as const };
    }
    const reservationRollbackSnapshot = snapshotStoreForRollback(state);
    job.state.queuedAtMs = reservationAt;
    // Persist the queued marker before releasing lock so timer ticks that
    // force-reload from disk cannot start the same job concurrently.
    await persistOrRestore(state, reservationRollbackSnapshot);
    const reservationIdentity = reserveQueuedCronRun(state, job.id, reservationAt, {
      preserveWhenDisabled: mode === "force" && !isJobEnabled(job),
    });
    if (state.stopped) {
      const cleanup = async () => {
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });
        const persistedJob = state.store?.jobs.find((entry) => entry.id === id);
        if (
          typeof persistedJob?.state.queuedAtMs !== "number" ||
          !isQueuedCronRunReservationMarkerCurrent(
            state,
            job.id,
            reservationIdentity,
            persistedJob.state.queuedAtMs,
          )
        ) {
          releaseQueuedCronRun(state, job.id, reservationIdentity);
          return;
        }
        const rollbackSnapshot = snapshotStoreForRollback(state);
        delete persistedJob.state.queuedAtMs;
        await persistOrRestore(state, rollbackSnapshot);
        releaseQueuedCronRun(state, job.id, reservationIdentity);
      };
      try {
        await cleanup();
      } catch {
        try {
          await cleanup();
        } catch (error) {
          // The stopped service has no cleanup owner left. Drop the process
          // claim so restart/stuck-marker recovery can repair the durable marker.
          releaseQueuedCronRun(state, job.id, reservationIdentity);
          throw error;
        }
      }
      return { ok: true, ran: false, reason: "stopped" as const };
    }
    return {
      ok: true,
      ran: true,
      jobId: job.id,
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
  mode?: "due" | "force",
): Promise<ActivatedManualRun | Extract<PreparedManualRun, { ran: false }>> {
  return await locked(state, async () => {
    // Reservations can wait behind another cron run. Reload under the service
    // lock so disabling, rescheduling, or removing the job wins that wait.
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    if (state.stopped) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "stopped" } as const;
    }
    if (state.restartRecoveryPending) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "restart-recovery-pending" } as const;
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
      !isJobDue(dueProbe, state.deps.nowMs(), { forced: mode === "force" })
    ) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "not-due" } as const;
    }
    try {
      assertSupportedJobSpec(job);
    } catch (error) {
      await skipInvalidPersistedManualRun({
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

    const startedAt = state.deps.nowMs();
    const previousLastError = job.state.lastError;
    const activationRollbackSnapshot = snapshotStoreForRollback(state);
    delete job.state.queuedAtMs;
    job.state.runningAtMs = startedAt;
    job.state.lastError = undefined;
    // A failed write restores the durable reservation; run() owns releasing
    // that queued claim for every activation failure before it propagates.
    await persistOrRestore(state, activationRollbackSnapshot);
    updateQueuedCronRunReservationMarker(
      state,
      prepared.jobId,
      prepared.reservationIdentity,
      startedAt,
      previousLastError,
    );
    if (state.stopped || state.restartRecoveryPending) {
      job.state.lastError = previousLastError;
      const rollbackSnapshot = snapshotStoreForRollback(state);
      delete job.state.runningAtMs;
      try {
        await persistOrRestore(state, rollbackSnapshot);
      } catch (error) {
        await releasePreparedManualReservationWithRetry(state, prepared);
        throw error;
      }
      releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
      return {
        ok: true,
        ran: false,
        reason: state.stopped ? "stopped" : "restart-recovery-pending",
      } as const;
    }
    emit(state, { jobId: job.id, action: "started", job, runAtMs: startedAt });
    const taskRunId = tryCreateCronTaskRun({
      state,
      job,
      startedAt,
      publicRunId: prepared.runId,
    });
    const activeJobMarker = markManualCronJobActive(state, job);
    // Execute against a snapshot so later reload/merge can preserve delivery
    // target writeback from disk without mutating the running object.
    const admittedJob = structuredClone(job);
    const executionJob = structuredClone(job);
    if (mode === "force" && executionJob.trigger && !prepared.evaluateTrigger) {
      // Force means run the payload now; strip the gate only from this snapshot
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
      activeJobMarker,
      admittedJob,
      executionJob,
    } as const;
  });
}

async function releasePreparedManualReservation(
  state: CronServiceState,
  prepared: Extract<PreparedManualRun, { ran: true }>,
): Promise<void> {
  if (!isQueuedCronRunReservationCurrent(state, prepared.jobId, prepared.reservationIdentity)) {
    return;
  }
  const job = state.store?.jobs.find((entry) => entry.id === prepared.jobId);
  const rollbackSnapshot = snapshotStoreForRollback(state);
  if (
    !job ||
    !clearQueuedCronRunReservationMarker(
      state,
      prepared.jobId,
      prepared.reservationIdentity,
      job.state,
    )
  ) {
    releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
    return;
  }
  await persistOrRestore(state, rollbackSnapshot);
  releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
}

export async function releasePreparedManualReservationWithRetry(
  state: CronServiceState,
  prepared: Extract<PreparedManualRun, { ran: true }>,
): Promise<void> {
  try {
    await releasePreparedManualReservation(state, prepared);
  } catch {
    try {
      await releasePreparedManualReservation(state, prepared);
    } catch (error) {
      // No caller owns another retry. Let stale-marker recovery see the
      // durable marker instead of retaining a process-only queued claim.
      releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
      throw error;
    }
  }
}

export async function releasePreparedManualReservationAfterReloadWithRetry(
  state: CronServiceState,
  prepared: Extract<PreparedManualRun, { ran: true }>,
): Promise<void> {
  const attempt = async () => {
    await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      await releasePreparedManualReservation(state, prepared);
    });
  };
  try {
    await attempt();
  } catch {
    try {
      await attempt();
    } catch (error) {
      releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
      throw error;
    }
  }
}
