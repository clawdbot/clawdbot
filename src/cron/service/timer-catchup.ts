import { resolveCronJobConfigRevision } from "../config-revision.js";
import {
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceiptInDatabase,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import {
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  isJobEnabled,
  resolveJobErrorBackoffUntilMs,
} from "./jobs-scheduling.js";
import { locked } from "./locked.js";
import {
  cleanupQueuedCronRunReservations,
  executeQueuedCronRun,
  persistQueuedCronRunReservations,
  releaseQueuedCronRun,
  reserveQueuedCronRun,
} from "./run-admission.js";
import { recomputeUnownedCronSchedules } from "./run-recovery.js";
import { applyCronRuntimeRowsToState, commitCronRuntimeRows } from "./runtime-store.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { ensureLoaded, runPostPersistCronNotifications } from "./store.js";
import {
  DEFAULT_MAX_MISSED_JOBS_PER_RESTART,
  DEFAULT_MISSED_JOB_STAGGER_MS,
  DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
  type StartupCatchupCandidate,
  type StartupCatchupExecution,
  type StartupCatchupPlan,
  type StartupDeferredJob,
  type TimedCronRunOutcome,
} from "./timer-execution-timeout.js";
import { createCompletedCronRunOutcomeDrain } from "./timer-outcome-finalization.js";
import { collectRunnableJobs, hasMissedCronSlotSinceLastRun } from "./timer-runnable.js";
import { maybeNotifyIsolatedAgentSetupTimeout } from "./timer-scheduler.js";
import { resolveNextRunAtMsOrDisable } from "./timer-trigger.js";

function deferPendingBackoffMissedCronSlots(
  state: CronServiceState,
  nowMs: number,
  opts?: { skipJobIds?: ReadonlySet<string> },
): boolean {
  if (!state.store) {
    return false;
  }
  const committedJobs = commitCronRuntimeRows({
    state,
    jobIds: state.store.jobs.map((job) => job.id),
    operationLabel: "cron.startup-backoff",
    mutate: ({ jobs }) => {
      const committed: CronJob[] = [];
      for (const job of jobs.values()) {
        if (
          !isJobEnabled(job) ||
          job.schedule.kind !== "cron" ||
          opts?.skipJobIds?.has(job.id) ||
          typeof job.state.queuedAtMs === "number" ||
          typeof job.state.runningAtMs === "number"
        ) {
          continue;
        }
        const backoffUntilMs = resolveJobErrorBackoffUntilMs(
          job,
          DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
        );
        if (
          backoffUntilMs === undefined ||
          nowMs >= backoffUntilMs ||
          !hasMissedCronSlotSinceLastRun(job, nowMs) ||
          job.state.nextRunAtMs === backoffUntilMs
        ) {
          continue;
        }
        job.state.nextRunAtMs = backoffUntilMs;
        committed.push(job);
      }
      return { upsertJobIds: committed.map((job) => job.id), value: committed };
    },
  });
  applyCronRuntimeRowsToState(state, committedJobs);
  return committedJobs.length > 0;
}

function commitStartupCatchupRows(params: {
  state: CronServiceState;
  reservations: readonly Pick<StartupCatchupCandidate, "jobId" | "reservationIdentity">[];
  deferredJobs?: readonly StartupDeferredJob[];
  staggerMs?: number;
}): void {
  const postPersistNotifications: DeferredCronNotifications = [];
  const deferredJobs = params.deferredJobs ?? [];
  const reservationByJobId = new Map(
    params.reservations.map((reservation) => [reservation.jobId, reservation] as const),
  );
  const deferredByJobId = new Map(deferredJobs.map((deferred) => [deferred.jobId, deferred]));
  const baseNow = params.state.deps.nowMs();
  let offset = params.staggerMs ?? 0;
  const committedJobs = commitCronRuntimeRows({
    state: params.state,
    jobIds: [...reservationByJobId.keys(), ...deferredByJobId.keys()],
    operationLabel: "cron.startup-catchup-state",
    mutate: ({ database, jobs }) => {
      const committed: CronJob[] = [];
      for (const [jobId, job] of jobs) {
        let changed = false;
        const reservation = reservationByJobId.get(jobId);
        const ownership = params.state.queuedRunReservationsByJobId.get(jobId);
        if (reservation && ownership?.identity === reservation.reservationIdentity) {
          finishCronRunReceiptInDatabase({
            database,
            handle: ownership.runReceipt,
            status: "skipped",
            finishedAtMs: params.state.deps.nowMs(),
            error: "cron startup reservation abandoned before completion",
          });
          if (ownership.activationPreviousLastError) {
            job.state.lastError = ownership.activationPreviousLastError.value;
          }
          if (ownership.markerAtMs === job.state.queuedAtMs) {
            delete job.state.queuedAtMs;
            changed = true;
          }
          if (ownership.markerAtMs === job.state.runningAtMs) {
            delete job.state.runningAtMs;
            changed = true;
          }
        }
        const deferred = deferredByJobId.get(jobId);
        if (
          deferred &&
          isJobEnabled(job) &&
          job.state.queuedAtMs === undefined &&
          job.state.runningAtMs === undefined &&
          job.state.nextRunAtMs === deferred.nextRunAtMs &&
          job.state.lastRunAtMs === deferred.lastRunAtMs &&
          job.state.lastRunStatus === deferred.lastRunStatus &&
          resolveCronJobConfigRevision(job) === deferred.configRevision &&
          !findActiveCronRunReceiptInDatabase({
            database,
            storePath: params.state.deps.storePath,
            jobId,
          })
        ) {
          const candidate =
            typeof deferred.delayMs === "number"
              ? baseNow + deferred.delayMs + offset - (params.staggerMs ?? 0)
              : baseNow + offset;
          const runAtMs = resolveNextRunAtMsOrDisable({
            state: params.state,
            job,
            candidate,
            deferredNotifications: postPersistNotifications,
          });
          job.state.nextRunAtMs = runAtMs;
          job.state.startupCatchupAtMs = runAtMs;
          offset += params.staggerMs ?? 0;
          changed = true;
        }
        if (changed) {
          committed.push(job);
        }
      }
      return {
        upsertJobIds: committed.map((job) => job.id),
        value: committed,
      };
    },
  });
  runPostPersistCronNotifications(params.state, postPersistNotifications);
  applyCronRuntimeRowsToState(params.state, committedJobs);
  for (const reservation of params.reservations) {
    const ownership = params.state.queuedRunReservationsByJobId.get(reservation.jobId);
    if (ownership?.identity === reservation.reservationIdentity) {
      releaseLocalCronRunReceiptOwnership(ownership.runReceipt);
    }
    releaseQueuedCronRun(params.state, reservation.jobId, reservation.reservationIdentity);
  }
}

async function releaseStartupCatchupReservationsAfterFailure(
  state: CronServiceState,
  plan: StartupCatchupPlan,
  outcomes: readonly TimedCronRunOutcome[],
): Promise<void> {
  const startedJobIds = new Set(outcomes.map((outcome) => outcome.jobId));
  await cleanupQueuedCronRunReservations({
    state,
    reservations: plan.candidates.filter((candidate) => !startedJobIds.has(candidate.jobId)),
    recompute: "startup-overflow",
  });
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
    try {
      await releaseStartupCatchupReservationsAfterFailure(state, plan, execution.outcomes);
    } catch (cleanupError) {
      state.deps.log.warn(
        { err: String(cleanupError) },
        execution.ok
          ? "cron: failed to release startup catch-up reservations after finalization error"
          : "cron: failed to release startup catch-up reservations after execution error",
      );
    }
    throw execution.ok ? finalizationError : execution.error;
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
    deferPendingBackoffMissedCronSlots(state, now, {
      skipJobIds: opts?.skipJobIds,
    });
    const missed = collectRunnableJobs(state, now, {
      skipJobIds: opts?.skipJobIds,
      skipAtIfAlreadyRan: true,
      allowCronMissedRunByLastRun: true,
    });
    if (missed.length === 0) {
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
    const deferredJob = (job: CronJob, delayMs?: number): StartupDeferredJob => ({
      jobId: job.id,
      ...(delayMs === undefined ? {} : { delayMs }),
      configRevision: resolveCronJobConfigRevision(job),
      nextRunAtMs: job.state.nextRunAtMs,
      lastRunAtMs: job.state.lastRunAtMs,
      lastRunStatus: job.state.lastRunStatus,
    });
    const deferred: StartupDeferredJob[] = [
      ...deferredOverflow.map((job) => deferredJob(job)),
      ...deferredAgentJobs.map((job) => deferredJob(job, deferredAgentDelayMs)),
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
    const reservedStartupCandidates = await persistQueuedCronRunReservations({
      state,
      candidates: startupCandidates,
      reservedAtMs: now,
    });

    return {
      candidates: reservedStartupCandidates.map(({ job, runReceipt }) => ({
        jobId: job.id,
        job,
        reservedAtMs: now,
        reservationIdentity: reserveQueuedCronRun(state, job.id, now, { runReceipt }),
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
      const execution = await executeQueuedCronRun({
        state,
        jobId: candidate.jobId,
        reservedAtMs: candidate.reservedAtMs,
        reservationIdentity: candidate.reservationIdentity,
        runnableOptions: {
          skipAtIfAlreadyRan: true,
          allowCronMissedRunByLastRun: true,
        },
        onNotRunnable: async () => {
          commitStartupCatchupRows({ state, reservations: [candidate] });
        },
      });
      if (execution.kind === "stopped") {
        break;
      }
      if (execution.kind === "completed") {
        // Catch-up execution stays sequential, while completed outcomes
        // persist in coalesced batches before slower siblings have to drain.
        outcomes.push(execution.outcome);
        completedOutcomeDrain.enqueue(execution.outcome);
      }
    }
  } catch (error) {
    return { ok: false, outcomes, error };
  }
  return { ok: true, outcomes };
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
    const startedJobIds = new Set(outcomes.map((outcome) => outcome.jobId));
    const pendingReleases = plan.candidates.filter(
      (candidate) => !startedJobIds.has(candidate.jobId),
    );
    if (state.stopped || (outcomes.length === 0 && plan.deferredJobs.length === 0)) {
      if (pendingReleases.length > 0) {
        commitStartupCatchupRows({ state, reservations: pendingReleases });
      }
      return;
    }
    commitStartupCatchupRows({
      state,
      reservations: pendingReleases,
      deferredJobs: plan.deferredJobs,
      staggerMs,
    });
    const maintenance = recomputeUnownedCronSchedules(state, {
      repairFutureCronNextRunAtMs: false,
    });
    runPostPersistCronNotifications(state, maintenance.notifications);
    applyCronRuntimeRowsToState(state, maintenance.jobs);
  });
  return outcomes;
}
import type { CronJob } from "../types.js";
