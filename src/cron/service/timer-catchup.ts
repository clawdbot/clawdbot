import { markCronJobActive } from "../active-jobs.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import {
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  isJobEnabled,
  recomputeNextRunsForMaintenance,
  resolveJobErrorBackoffUntilMs,
} from "./jobs.js";
import { locked } from "./locked.js";
import {
  activateQueuedCronRun,
  isQueuedCronRunReservationCurrent,
  releaseQueuedCronRun,
  reserveQueuedCronRun,
  runWithCronAdmission,
} from "./run-admission.js";
import { type CronServiceState, type DeferredCronNotifications, emit } from "./state.js";
import { ensureLoaded, persist, persistOrRestore, snapshotStoreForRollback } from "./store.js";
import { tryCreateCronTaskRun } from "./task-runs.js";
import {
  DEFAULT_MAX_MISSED_JOBS_PER_RESTART,
  DEFAULT_MISSED_JOB_STAGGER_MS,
  DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
  runsDetachedFromMainSession,
  type StartupCatchupCandidate,
  type StartupCatchupExecution,
  type StartupCatchupPlan,
  type StartupDeferredJob,
  type TimedCronRunOutcome,
} from "./timer-execution-timeout.js";
import { executeJobCoreWithTimeout } from "./timer-job-runner.js";
import {
  clearUnstartedStartupCatchupReservationMarkers,
  createCompletedCronRunOutcomeDrain,
} from "./timer-outcome-finalization.js";
import {
  collectRunnableJobs,
  hasMissedCronSlotSinceLastRun,
  isRunnableJob,
} from "./timer-runnable.js";
import { maybeNotifyIsolatedAgentSetupTimeout } from "./timer-scheduler.js";

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
      typeof job.state.queuedAtMs === "number" ||
      typeof job.state.runningAtMs === "number"
    ) {
      continue;
    }
    const backoffUntilMs = resolveJobErrorBackoffUntilMs(job, DEFAULT_ERROR_BACKOFF_SCHEDULE_MS);
    if (backoffUntilMs === undefined || nowMs >= backoffUntilMs) {
      continue;
    }
    if (!hasMissedCronSlotSinceLastRun(job, nowMs)) {
      continue;
    }
    if (job.state.nextRunAtMs !== backoffUntilMs) {
      job.state.nextRunAtMs = backoffUntilMs;
      changed = true;
    }
  }
  return changed;
}

async function releaseStartupCatchupReservationsAfterFailure(
  state: CronServiceState,
  plan: StartupCatchupPlan,
  outcomes: readonly TimedCronRunOutcome[],
): Promise<void> {
  const attempt = async () => {
    await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      const rollbackSnapshot = snapshotStoreForRollback(state);
      const pendingReleases = clearUnstartedStartupCatchupReservationMarkers(state, plan, outcomes);
      if (pendingReleases.length === 0) {
        return;
      }
      const postPersistNotifications: DeferredCronNotifications = [];
      recomputeNextRunsForMaintenance(state, {
        repairFutureCronNextRunAtMs: false,
        deferredNotifications: postPersistNotifications,
      });
      await persistOrRestore(state, rollbackSnapshot, { postPersistNotifications });
      for (const pending of pendingReleases) {
        releaseQueuedCronRun(state, pending.jobId, pending.reservationIdentity);
      }
    });
  };
  try {
    await attempt();
  } catch {
    try {
      await attempt();
    } catch (error) {
      // The failed execution has no remaining cleanup owner. Release process
      // claims so durable stuck-marker recovery can eventually repair them.
      for (const candidate of plan.candidates) {
        releaseQueuedCronRun(state, candidate.jobId, candidate.reservationIdentity);
      }
      throw error;
    }
  }
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

  const completedOutcomeDrain = createCompletedCronRunOutcomeDrain(state, {
    discardWhenStopped: true,
    repairFutureCronNextRunAtMs: false,
  });
  const execution = await executeStartupCatchupPlan(state, plan, completedOutcomeDrain);
  let finalizedOutcomes: TimedCronRunOutcome[];
  try {
    let completedOutcomes: TimedCronRunOutcome[];
    try {
      completedOutcomes = await completedOutcomeDrain.flush();
    } catch (drainError) {
      // Preserve overflow wake times and release every unstarted reservation
      // even when a completed sibling's terminal store write has failed.
      await applyStartupCatchupOutcomes(state, plan, execution.outcomes);
      throw drainError;
    }
    finalizedOutcomes = await applyStartupCatchupOutcomes(state, plan, completedOutcomes);
  } catch (finalizationError) {
    if (execution.ok) {
      try {
        await releaseStartupCatchupReservationsAfterFailure(state, plan, execution.outcomes);
      } catch (cleanupError) {
        state.deps.log.warn(
          { err: String(cleanupError) },
          "cron: failed to release startup catch-up reservations after finalization error",
        );
      }
      throw finalizationError;
    }
    try {
      await releaseStartupCatchupReservationsAfterFailure(state, plan, execution.outcomes);
    } catch (cleanupError) {
      state.deps.log.warn(
        { err: String(cleanupError) },
        "cron: failed to release startup catch-up reservations after execution error",
      );
    }
    throw execution.error;
  }
  for (const outcome of finalizedOutcomes) {
    maybeNotifyIsolatedAgentSetupTimeout(state, outcome);
  }
  if (!execution.ok) {
    throw execution.error;
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
    const reservationRollbackSnapshot = snapshotStoreForRollback(state);
    for (const job of startupCandidates) {
      job.state.queuedAtMs = now;
    }
    await persistOrRestore(state, reservationRollbackSnapshot);

    return {
      candidates: startupCandidates.map((job) => ({
        jobId: job.id,
        job,
        reservedAtMs: now,
        reservationIdentity: reserveQueuedCronRun(state, job.id, now),
      })),
      deferredJobs: deferred,
    };
  });
}

async function executeStartupCatchupPlan(
  state: CronServiceState,
  plan: StartupCatchupPlan,
  completedOutcomeDrain: ReturnType<typeof createCompletedCronRunOutcomeDrain>,
): Promise<StartupCatchupExecution> {
  const outcomes: TimedCronRunOutcome[] = [];
  try {
    for (const candidate of plan.candidates) {
      if (state.stopped) {
        break;
      }
      const admission = await runWithCronAdmission(state, async () => {
        const startedCandidate = await locked(state, async () => {
          await ensureLoaded(state, { forceReload: true, skipRecompute: true });
          const job = state.store?.jobs.find((entry) => entry.id === candidate.jobId);
          if (state.stopped || state.restartRecoveryPending) {
            return undefined;
          }
          if (
            !job ||
            !isQueuedCronRunReservationCurrent(
              state,
              candidate.jobId,
              candidate.reservationIdentity,
            ) ||
            job.state.queuedAtMs !== candidate.reservedAtMs
          ) {
            releaseQueuedCronRun(state, candidate.jobId, candidate.reservationIdentity);
            return undefined;
          }
          const dueProbe = structuredClone(job);
          delete dueProbe.state.queuedAtMs;
          if (
            !isRunnableJob({
              state,
              job: dueProbe,
              nowMs: state.deps.nowMs(),
              skipAtIfAlreadyRan: true,
              allowCronMissedRunByLastRun: true,
            })
          ) {
            const rollbackSnapshot = snapshotStoreForRollback(state);
            delete job.state.queuedAtMs;
            const postPersistNotifications: DeferredCronNotifications = [];
            recomputeNextRunsForMaintenance(state, {
              repairFutureCronNextRunAtMs: false,
              deferredNotifications: postPersistNotifications,
            });
            await persistOrRestore(state, rollbackSnapshot, { postPersistNotifications });
            releaseQueuedCronRun(state, candidate.jobId, candidate.reservationIdentity);
            return undefined;
          }
          const activation = await activateQueuedCronRun({
            state,
            job,
            reservationIdentity: candidate.reservationIdentity,
          });
          if (activation.kind === "unavailable") {
            return undefined;
          }
          return { ...candidate, job, startedAt: activation.startedAt };
        });
        if (!startedCandidate) {
          return undefined;
        }
        try {
          return await runStartupCatchupCandidate(state, startedCandidate);
        } catch (error) {
          releaseQueuedCronRun(state, candidate.jobId, candidate.reservationIdentity);
          throw error;
        }
      });
      if (admission.kind === "stopped") {
        break;
      }
      if (admission.value) {
        // Catch-up execution stays sequential, while completed outcomes
        // persist in coalesced batches before slower siblings have to drain.
        outcomes.push(admission.value);
        completedOutcomeDrain.enqueue(admission.value);
      }
    }
  } catch (error) {
    return { ok: false, outcomes, error };
  }
  return { ok: true, outcomes };
}

async function runStartupCatchupCandidate(
  state: CronServiceState,
  candidate: StartupCatchupCandidate & { startedAt: number },
): Promise<TimedCronRunOutcome> {
  const { startedAt } = candidate;
  const executionJob = structuredClone(candidate.job);
  executionJob.state.runningAtMs = startedAt;
  const taskRunId = tryCreateCronTaskRun({
    state,
    job: executionJob,
    startedAt,
  });
  const activeJobMarker = markCronJobActive(executionJob.id, {
    preserveAcrossGenerationAdvance: !runsDetachedFromMainSession(executionJob),
  });
  emit(state, {
    jobId: executionJob.id,
    action: "started",
    job: executionJob,
    runAtMs: startedAt,
  });
  try {
    const result = await executeJobCoreWithTimeout(state, executionJob, {
      runId: taskRunId,
      activeJobMarker,
    });
    return {
      jobId: candidate.jobId,
      job: executionJob,
      taskRunId,
      activeJobMarker,
      reservationIdentity: candidate.reservationIdentity,
      // Keep the complete core outcome: startup catch-up shares the same result
      // application path as timer runs, including delivery and script state.
      ...result,
      startedAt,
      endedAt: state.deps.nowMs(),
    };
  } catch (err) {
    return {
      jobId: candidate.jobId,
      job: executionJob,
      taskRunId,
      activeJobMarker,
      reservationIdentity: candidate.reservationIdentity,
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
  await locked(state, async () => {
    // Each completed run is already durable. Reload before releasing or
    // staggering sibling reservations so their current rows stay authoritative.
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    if (!state.store) {
      return;
    }
    if (state.stopped) {
      const rollbackSnapshot = snapshotStoreForRollback(state);
      const pendingReleases = clearUnstartedStartupCatchupReservationMarkers(state, plan, outcomes);
      if (pendingReleases.length > 0) {
        const postPersistNotifications: DeferredCronNotifications = [];
        recomputeNextRunsForMaintenance(state, {
          repairFutureCronNextRunAtMs: false,
          deferredNotifications: postPersistNotifications,
        });
        await persistOrRestore(state, rollbackSnapshot, { postPersistNotifications });
        for (const pending of pendingReleases) {
          releaseQueuedCronRun(state, pending.jobId, pending.reservationIdentity);
        }
      }
      return;
    }

    const rollbackSnapshot = snapshotStoreForRollback(state);
    const pendingReleases = clearUnstartedStartupCatchupReservationMarkers(state, plan, outcomes);
    if (outcomes.length === 0 && plan.deferredJobs.length === 0) {
      if (pendingReleases.length > 0) {
        const postPersistNotifications: DeferredCronNotifications = [];
        recomputeNextRunsForMaintenance(state, {
          repairFutureCronNextRunAtMs: false,
          deferredNotifications: postPersistNotifications,
        });
        await persistOrRestore(state, rollbackSnapshot, { postPersistNotifications });
        for (const pending of pendingReleases) {
          releaseQueuedCronRun(state, pending.jobId, pending.reservationIdentity);
        }
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
          const runAtMs = baseNow + deferred.delayMs + offset - staggerMs;
          job.state.nextRunAtMs = runAtMs;
          job.state.startupCatchupAtMs = runAtMs;
          offset += staggerMs;
          continue;
        }
        const runAtMs = baseNow + offset;
        job.state.nextRunAtMs = runAtMs;
        job.state.startupCatchupAtMs = runAtMs;
        offset += staggerMs;
      }
    }

    // Startup overflow owns these staggered wake times; repairing future
    // schedules here would silently move a deferred run to its natural slot.
    const postPersistNotifications: DeferredCronNotifications = [];
    recomputeNextRunsForMaintenance(state, {
      repairFutureCronNextRunAtMs: false,
      deferredNotifications: postPersistNotifications,
    });
    await persistOrRestore(state, rollbackSnapshot, { postPersistNotifications });
    for (const pending of pendingReleases) {
      releaseQueuedCronRun(state, pending.jobId, pending.reservationIdentity);
    }
  });
  return outcomes;
}
