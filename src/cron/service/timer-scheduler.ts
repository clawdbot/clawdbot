import pMap, { pMapSkip } from "p-map";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  beginGatewayRootWorkAdmissionWhenOpen,
  GatewayDrainingError,
} from "../../process/gateway-work-admission.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import { markCronJobActive } from "../active-jobs.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import { sweepCronRunSessions } from "../session-reaper.js";
import type { CronJob } from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import {
  hasScheduledNextRunAtMs,
  isJobEnabled,
  nextWakeAtMs,
  recomputeNextRunsForMaintenance,
} from "./jobs.js";
import { locked } from "./locked.js";
import {
  clearQueuedCronRunReservationMarker,
  isQueuedCronRunReservationCurrent,
  isQueuedCronRunReservationMarkerCurrent,
  releaseQueuedCronRun,
  reserveQueuedCronRun,
  resolveRunConcurrency,
  restoreQueuedCronRunReservationLastError,
  runWithCronAdmission,
  updateQueuedCronRunReservationMarker,
} from "./run-admission.js";
import { type CronServiceState, emit } from "./state.js";
import { ensureLoaded, persist, persistOrRestore, snapshotStoreForRollback } from "./store.js";
import { tryCreateCronTaskRun } from "./task-runs.js";
import { resolveCronJobTimeoutMs } from "./timeout-policy.js";
import {
  MAX_TIMER_DELAY_MS,
  MIN_REFIRE_GAP_MS,
  runsDetachedFromMainSession,
  type TimedCronRunOutcome,
} from "./timer-execution-timeout.js";
import { executeJobCoreWithTimeout } from "./timer-job-runner.js";
import { maybeNotifyIsolatedAgentSetupTimeoutWithRecovery } from "./timer-notifications.js";
import {
  clearActiveMarkersForOutcomes,
  filterCurrentCronRunOutcomes,
  finishPersistedQuietCronTaskRuns,
  finishRetiredCronTaskRuns,
} from "./timer-outcome-finalization.js";
import { applyOutcomeToStoredJob } from "./timer-outcomes.js";
import { collectRunnableJobs, isRunnableJob } from "./timer-runnable.js";

export function maybeNotifyIsolatedAgentSetupTimeout(
  state: CronServiceState,
  result: Parameters<typeof maybeNotifyIsolatedAgentSetupTimeoutWithRecovery>[1],
): boolean {
  return maybeNotifyIsolatedAgentSetupTimeoutWithRecovery(state, result, () => armTimer(state));
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
      const reservationRollbackSnapshot = snapshotStoreForRollback(state);
      for (const job of due) {
        job.state.queuedAtMs = now;
      }
      await persistOrRestore(state, reservationRollbackSnapshot);
      const reservedDue = due.map((job) => ({
        id: job.id,
        job,
        reservedAtMs: now,
        reservationIdentity: reserveQueuedCronRun(state, job.id, now),
      }));
      if (state.stopped) {
        const cleanup = async () => {
          const rollbackSnapshot = snapshotStoreForRollback(state);
          const pendingReleases: typeof reservedDue = [];
          for (const candidate of reservedDue) {
            if (
              !isQueuedCronRunReservationCurrent(state, candidate.id, candidate.reservationIdentity)
            ) {
              continue;
            }
            const persistedJob = state.store?.jobs.find((entry) => entry.id === candidate.id);
            if (
              typeof persistedJob?.state.queuedAtMs === "number" &&
              isQueuedCronRunReservationMarkerCurrent(
                state,
                candidate.id,
                candidate.reservationIdentity,
                persistedJob.state.queuedAtMs,
              )
            ) {
              restoreQueuedCronRunReservationLastError(
                state,
                candidate.id,
                candidate.reservationIdentity,
                persistedJob.state,
              );
              delete persistedJob.state.queuedAtMs;
              pendingReleases.push(candidate);
            } else {
              releaseQueuedCronRun(state, candidate.id, candidate.reservationIdentity);
            }
          }
          recomputeNextRunsForMaintenance(state);
          await persistOrRestore(state, rollbackSnapshot);
          for (const candidate of pendingReleases) {
            releaseQueuedCronRun(state, candidate.id, candidate.reservationIdentity);
          }
        };
        try {
          await cleanup();
        } catch {
          try {
            await cleanup();
          } catch (error) {
            // The stopped scheduler has no later cleanup pass.
            for (const candidate of reservedDue) {
              releaseQueuedCronRun(state, candidate.id, candidate.reservationIdentity);
            }
            throw error;
          }
        }
        return [];
      }

      return reservedDue;
    });

    const runDueJob = async (params: {
      id: string;
      job: CronJob;
      reservedAtMs: number;
      reservationIdentity: object;
      startedAt: number;
    }): Promise<TimedCronRunOutcome> => {
      const { id, job, startedAt } = params;
      const executionJob = structuredClone(job);
      executionJob.state.runningAtMs = startedAt;
      executionJob.state.lastError = undefined;
      const activeJobMarker = markCronJobActive(executionJob.id, {
        preserveAcrossGenerationAdvance: !runsDetachedFromMainSession(executionJob),
      });
      emit(state, {
        jobId: executionJob.id,
        action: "started",
        job: executionJob,
        runAtMs: startedAt,
      });
      const jobTimeoutMs = resolveCronJobTimeoutMs(executionJob);
      const taskRunId = tryCreateCronTaskRun({
        state,
        job: executionJob,
        startedAt,
        runIdStartedAt: params.reservedAtMs,
      });

      try {
        const result = await executeJobCoreWithTimeout(state, executionJob, {
          runId: taskRunId,
          activeJobMarker,
        });
        return {
          jobId: id,
          job: executionJob,
          taskRunId,
          activeJobMarker,
          reservationIdentity: params.reservationIdentity,
          ...result,
          startedAt,
          endedAt: state.deps.nowMs(),
        };
      } catch (err) {
        const errorText = normalizeCronRunErrorText(err);
        state.deps.log.warn(
          { jobId: id, jobName: executionJob.name, timeoutMs: jobTimeoutMs ?? null },
          `cron: job failed: ${errorText}`,
        );
        return {
          jobId: id,
          job: executionJob,
          taskRunId,
          activeJobMarker,
          reservationIdentity: params.reservationIdentity,
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
          const rollbackSnapshot = snapshotStoreForRollback(state);
          const removedJobs: CronJob[] = [];
          for (const result of finalizedResults) {
            const removedJob = applyOutcomeToStoredJob(state, result);
            if (removedJob) {
              removedJobs.push(removedJob);
            }
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
          await persistOrRestore(state, rollbackSnapshot);
          finishPersistedQuietCronTaskRuns(state, finalizedResults);
          for (const removedJob of removedJobs) {
            emit(state, { jobId: removedJob.id, action: "removed", job: removedJob });
          }
        });
        finalizationSucceeded = finalizedResults.length > 0;
        return finalizedResults;
      } finally {
        for (const result of completedResults) {
          if (result.reservationIdentity) {
            releaseQueuedCronRun(state, result.jobId, result.reservationIdentity);
          }
        }
        if (opts?.clearOnFailure !== false || finalizationSucceeded) {
          clearActiveMarkersForOutcomes(completedResults);
        }
      }
    };

    const concurrency = Math.min(resolveRunConcurrency(), Math.max(1, dueJobs.length));
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
        const rollbackSnapshot = snapshotStoreForRollback(state);
        const pendingReleases: typeof dueJobs = [];
        for (const [index, due] of dueJobs.entries()) {
          if (claimedIndexes.has(index)) {
            continue;
          }
          const job = state.store?.jobs.find((entry) => entry.id === due.id);
          if (
            job &&
            clearQueuedCronRunReservationMarker(state, due.id, due.reservationIdentity, job.state)
          ) {
            pendingReleases.push(due);
          } else {
            releaseQueuedCronRun(state, due.id, due.reservationIdentity);
          }
        }
        recomputeNextRunsForMaintenance(state);
        await persistOrRestore(state, rollbackSnapshot);
        for (const due of pendingReleases) {
          releaseQueuedCronRun(state, due.id, due.reservationIdentity);
        }
      });
    };
    const releaseUnclaimedDueJobReservationsWithRetry = async () => {
      try {
        await releaseUnclaimedDueJobReservations();
      } catch {
        try {
          await releaseUnclaimedDueJobReservations();
        } catch (error) {
          // No timer task owns another retry. Drop only these process claims so
          // durable stuck-marker recovery remains able to repair them.
          for (const [index, due] of dueJobs.entries()) {
            if (!claimedIndexes.has(index)) {
              releaseQueuedCronRun(state, due.id, due.reservationIdentity);
            }
          }
          throw error;
        }
      }
    };
    if (state.stopped) {
      await releaseUnclaimedDueJobReservationsWithRetry();
      return;
    }
    // Skipped mappers must not claim reservations: recovery releases those rows,
    // while already-started jobs drain under the same service-wide cap.
    let completedResults: TimedCronRunOutcome[];
    let batchExecutionError: unknown;
    try {
      completedResults = await pMap(
        dueJobs,
        async (due, index): Promise<TimedCronRunOutcome | typeof pMapSkip> => {
          if (stopAdmittingDueJobs || state.stopped || state.restartRecoveryPending) {
            stopAdmittingDueJobs = true;
            return pMapSkip;
          }
          try {
            const admission = await runWithCronAdmission(state, async () => {
              const currentDueJob = await locked(state, async () => {
                await ensureLoaded(state, { forceReload: true, skipRecompute: true });
                if (stopAdmittingDueJobs || state.stopped || state.restartRecoveryPending) {
                  stopAdmittingDueJobs = true;
                  return undefined;
                }
                const job = state.store?.jobs.find((entry) => entry.id === due.id);
                if (
                  !job ||
                  !isQueuedCronRunReservationCurrent(state, due.id, due.reservationIdentity) ||
                  job.state.queuedAtMs !== due.reservedAtMs
                ) {
                  releaseQueuedCronRun(state, due.id, due.reservationIdentity);
                  return undefined;
                }
                const dueProbe = structuredClone(job);
                delete dueProbe.state.queuedAtMs;
                if (
                  !isJobEnabled(job) ||
                  !isRunnableJob({ state, job: dueProbe, nowMs: state.deps.nowMs() })
                ) {
                  const rollbackSnapshot = snapshotStoreForRollback(state);
                  delete job.state.queuedAtMs;
                  await persistOrRestore(state, rollbackSnapshot);
                  releaseQueuedCronRun(state, due.id, due.reservationIdentity);
                  return undefined;
                }
                const startedAt = state.deps.nowMs();
                const previousLastError = job.state.lastError;
                const activationRollbackSnapshot = snapshotStoreForRollback(state);
                delete job.state.queuedAtMs;
                job.state.runningAtMs = startedAt;
                job.state.lastError = undefined;
                await persistOrRestore(state, activationRollbackSnapshot);
                updateQueuedCronRunReservationMarker(
                  state,
                  due.id,
                  due.reservationIdentity,
                  startedAt,
                  previousLastError,
                );
                if (state.stopped || state.restartRecoveryPending) {
                  stopAdmittingDueJobs = true;
                  job.state.lastError = previousLastError;
                  const rollbackSnapshot = snapshotStoreForRollback(state);
                  delete job.state.runningAtMs;
                  await persistOrRestore(state, rollbackSnapshot);
                  releaseQueuedCronRun(state, due.id, due.reservationIdentity);
                  return undefined;
                }
                return { ...due, job, startedAt };
              });
              if (!currentDueJob) {
                return pMapSkip;
              }
              claimedIndexes.add(index);
              let result: TimedCronRunOutcome;
              try {
                result = await runDueJob(currentDueJob);
              } catch (error) {
                releaseQueuedCronRun(state, due.id, due.reservationIdentity);
                throw error;
              }
              if (!result.isolatedAgentSetupTimeout) {
                return result;
              }
              let finalizedResults: TimedCronRunOutcome[];
              try {
                finalizedResults = await finalizeCompletedResults([result], {
                  clearOnFailure: false,
                });
              } catch {
                return result;
              }
              if (!hasSetupTimeoutRecoveryHandler || finalizedResults.length === 0) {
                return pMapSkip;
              }
              if (!setupTimeoutNotified) {
                setupTimeoutNotified = true;
                stopAdmittingDueJobs = true;
                try {
                  await releaseUnclaimedDueJobReservationsWithRetry();
                } catch (err) {
                  reservationReleaseError = err;
                }
                maybeNotifyIsolatedAgentSetupTimeout(state, result);
              }
              return pMapSkip;
            });
            if (admission.kind === "stopped") {
              stopAdmittingDueJobs = true;
              return pMapSkip;
            }
            return admission.value;
          } catch (error) {
            stopAdmittingDueJobs = true;
            batchExecutionError ??= error;
            return pMapSkip;
          }
        },
        // Let already-admitted mappers drain so their outcomes can be persisted
        // even when a sibling activation fails.
        { concurrency, stopOnError: false },
      );
    } catch (error) {
      await releaseUnclaimedDueJobReservationsWithRetry();
      throw error instanceof AggregateError && error.errors.length > 0 ? error.errors[0] : error;
    }
    let postBatchError = reservationReleaseError;
    if (stopAdmittingDueJobs) {
      try {
        await releaseUnclaimedDueJobReservationsWithRetry();
      } catch (error) {
        postBatchError ??= error;
      }
    }

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
    if (postBatchError) {
      throw postBatchError instanceof Error
        ? postBatchError
        : new Error(formatErrorMessage(postBatchError));
    }
    if (batchExecutionError) {
      throw batchExecutionError instanceof Error
        ? batchExecutionError
        : new Error(formatErrorMessage(batchExecutionError));
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
