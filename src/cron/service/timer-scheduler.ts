import pMap, { pMapSkip } from "p-map";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  beginGatewayRootWorkAdmissionWhenOpen,
  GatewayDrainingError,
} from "../../process/gateway-work-admission.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { sweepCronRunSessions } from "../session-reaper.js";
import type { CronJob } from "../types.js";
import {
  hasScheduledNextRunAtMs,
  nextWakeAtMs,
  recomputeNextRunsForMaintenance,
} from "./jobs-scheduling.js";
import { locked } from "./locked.js";
import {
  cleanupQueuedCronRunReservations,
  executeQueuedCronRun,
  releaseQueuedCronRun,
  reserveQueuedCronRun,
  resolveRunConcurrency,
} from "./run-admission.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { ensureLoaded, persistOrRestore, snapshotStoreForRollback } from "./store.js";
import { resolveCronJobTimeoutMs } from "./timeout-policy.js";
import {
  MAX_CRON_TIMER_DELAY_MS,
  MIN_REFIRE_GAP_MS,
  type TimedCronRunOutcome,
} from "./timer-execution-timeout.js";
import { maybeNotifyIsolatedAgentSetupTimeoutWithRecovery } from "./timer-notifications.js";
import {
  createCompletedCronRunOutcomeDrain,
  finalizeCompletedCronRunOutcomes,
} from "./timer-outcome-finalization.js";
import { collectRunnableJobs } from "./timer-runnable.js";

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
        { jobCount, enabledCount, withNextRun, delayMs: MAX_CRON_TIMER_DELAY_MS },
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
  const clampedDelay = Math.min(flooredDelay, MAX_CRON_TIMER_DELAY_MS);
  // Intentionally avoid an `async` timer callback:
  // Vitest's fake-timer helpers can await async callbacks, which would block
  // tests that simulate long-running jobs. Runtime behavior is unchanged.
  setCronTimer(state, clampedDelay);
  state.deps.log.debug(
    { nextAt, delayMs: clampedDelay, clamped: delay > MAX_CRON_TIMER_DELAY_MS },
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
  setCronTimer(state, MAX_CRON_TIMER_DELAY_MS);
}

function setCronTimer(state: CronServiceState, delayMs: number): void {
  state.timer = setTimeout(() => {
    void onTimer(state).catch((err: unknown) => {
      state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
    });
  }, delayMs);
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
    // exceeding MAX_CRON_TIMER_DELAY_MS) causes the clamped 60 s timer to fire
    // while `running` is true.  The early return then leaves no timer set,
    // silently killing the scheduler until the next gateway restart.
    //
    // We use MAX_CRON_TIMER_DELAY_MS as a fixed re-check interval to avoid a
    // zero-delay hot-loop when past-due jobs are waiting for the current
    // execution to finish.
    // See: https://github.com/openclaw/openclaw/issues/12025
    armRunningRecheckTimer(state);
    return;
  }
  let sessionReaperDefaultAgentId: string | undefined;
  state.running = true;
  // Keep a watchdog timer armed while a tick is executing. If execution hangs
  // (for example in a provider call), the scheduler still wakes to re-check.
  armRunningRecheckTimer(state);
  try {
    const hasSessionReaperStore = Boolean(
      state.deps.resolveSessionStorePath || state.deps.sessionStorePath,
    );
    sessionReaperDefaultAgentId = hasSessionReaperStore
      ? (state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId)?.trim()
      : undefined;
    if (hasSessionReaperStore && !sessionReaperDefaultAgentId) {
      throw new Error("Cron session reaper requires the prepared configured default agent id.");
    }
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
        const rollbackSnapshot = snapshotStoreForRollback(state);
        const postPersistNotifications: DeferredCronNotifications = [];
        const changed = recomputeNextRunsForMaintenance(state, {
          recomputeExpired: true,
          nowMs: dueCheckNow,
          deferredNotifications: postPersistNotifications,
        });
        if (changed) {
          await persistOrRestore(state, rollbackSnapshot, { postPersistNotifications });
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
      return reservedDue;
    });

    const concurrency = Math.min(resolveRunConcurrency(), Math.max(1, dueJobs.length));
    const completedOutcomeDrain = createCompletedCronRunOutcomeDrain(state);
    const claimedIndexes = new Set<number>();
    let reservationReleaseError: unknown;
    let setupTimeoutNotified = false;
    let stopAdmittingDueJobs = false;
    const hasSetupTimeoutRecoveryHandler = state.deps.onIsolatedAgentSetupTimeout !== undefined;
    const releaseUnclaimedDueJobReservationsWithRetry = async () => {
      const reservations = dueJobs
        .filter((_, index) => !claimedIndexes.has(index))
        .map((due) => ({
          jobId: due.id,
          reservationIdentity: due.reservationIdentity,
        }));
      await cleanupQueuedCronRunReservations({
        state,
        reservations,
        recompute: "maintenance",
      });
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
            const execution = await executeQueuedCronRun({
              state,
              jobId: due.id,
              reservedAtMs: due.reservedAtMs,
              reservationIdentity: due.reservationIdentity,
              isUnavailable: () => stopAdmittingDueJobs,
              onUnavailable: () => {
                stopAdmittingDueJobs = true;
              },
              onActivated: () => claimedIndexes.add(index),
              onNotRunnable: async (job) => {
                const rollbackSnapshot = snapshotStoreForRollback(state);
                delete job.state.queuedAtMs;
                await persistOrRestore(state, rollbackSnapshot);
                releaseQueuedCronRun(state, due.id, due.reservationIdentity);
              },
              onSetupError: (job, errorText) => {
                state.deps.log.warn(
                  {
                    jobId: due.id,
                    jobName: job.name,
                    timeoutMs: resolveCronJobTimeoutMs(job) ?? null,
                  },
                  `cron: job failed: ${errorText}`,
                );
              },
              onCompleted: async (result) => {
                if (!result.isolatedAgentSetupTimeout) {
                  // Drain finished state independently: a slow sibling must not
                  // strand outcomes, and store I/O must not own execution slots.
                  completedOutcomeDrain.enqueue(result);
                  return true;
                }
                let finalizedResults: TimedCronRunOutcome[];
                try {
                  finalizedResults = await finalizeCompletedCronRunOutcomes(state, [result], {
                    clearOnFailure: false,
                  });
                } catch {
                  return false;
                }
                if (
                  hasSetupTimeoutRecoveryHandler &&
                  finalizedResults.length > 0 &&
                  !setupTimeoutNotified
                ) {
                  setupTimeoutNotified = true;
                  stopAdmittingDueJobs = true;
                  try {
                    await releaseUnclaimedDueJobReservationsWithRetry();
                  } catch (err) {
                    reservationReleaseError = err;
                  }
                  maybeNotifyIsolatedAgentSetupTimeout(state, result);
                }
                return true;
              },
            });
            if (execution.kind === "stopped") {
              stopAdmittingDueJobs = true;
              return pMapSkip;
            }
            if (execution.kind === "skipped") {
              return pMapSkip;
            }
            if (execution.handled) {
              return pMapSkip;
            }
            return execution.outcome;
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
      let finalizationError: unknown;
      try {
        await completedOutcomeDrain.flush();
      } catch (drainError) {
        finalizationError = drainError;
      }
      await releaseUnclaimedDueJobReservationsWithRetry();
      if (finalizationError) {
        throw finalizationError instanceof Error
          ? finalizationError
          : new Error(formatErrorMessage(finalizationError));
      }
      throw error instanceof AggregateError && error.errors.length > 0 ? error.errors[0] : error;
    }
    let postBatchError = reservationReleaseError;
    try {
      await completedOutcomeDrain.flush();
    } catch (error) {
      // Finalization errors still need to release every unclaimed durable
      // reservation before the failed timer batch can exit.
      postBatchError ??= error;
      stopAdmittingDueJobs = true;
    }
    if (stopAdmittingDueJobs) {
      try {
        await releaseUnclaimedDueJobReservationsWithRetry();
      } catch (error) {
        postBatchError ??= error;
      }
    }

    if (completedResults.length > 0) {
      const finalizedResults = await finalizeCompletedCronRunOutcomes(state, completedResults);
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
    try {
      // Reaper discovery is maintenance: failure must never strand the timer
      // or leave the scheduler's execution slot permanently occupied.
      if (sessionReaperDefaultAgentId) {
        const defaultAgentId = sessionReaperDefaultAgentId;
        const storeTargets = new Map<string, { agentId: string; storePath: string }>();
        const addStoreTarget = (agentId: string, storePath: string) => {
          storeTargets.set(`${agentId}\0${storePath}`, { agentId, storePath });
        };
        const resolveJobAgentId = (job: CronJob) =>
          typeof job.agentId === "string" && job.agentId.trim()
            ? normalizeAgentId(job.agentId)
            : resolveAgentIdFromSessionKey(job.sessionKey, defaultAgentId);
        const configuredAgentIds = state.deps.resolveSessionStoreAgentIds?.() ?? [];
        if (state.deps.resolveSessionStorePath) {
          for (const agentId of configuredAgentIds) {
            const normalizedAgentId = normalizeAgentId(agentId);
            addStoreTarget(
              normalizedAgentId,
              state.deps.resolveSessionStorePath(normalizedAgentId),
            );
          }
          for (const job of state.store?.jobs ?? []) {
            const agentId = resolveJobAgentId(job);
            addStoreTarget(agentId, state.deps.resolveSessionStorePath(agentId));
          }
          addStoreTarget(defaultAgentId, state.deps.resolveSessionStorePath(defaultAgentId));
        } else if (state.deps.sessionStorePath) {
          for (const agentId of configuredAgentIds) {
            addStoreTarget(normalizeAgentId(agentId), state.deps.sessionStorePath);
          }
          for (const job of state.store?.jobs ?? []) {
            addStoreTarget(resolveJobAgentId(job), state.deps.sessionStorePath);
          }
          addStoreTarget(defaultAgentId, state.deps.sessionStorePath);
        }

        if (storeTargets.size > 0) {
          const nowMs = state.deps.nowMs();
          for (const { agentId, storePath } of storeTargets.values()) {
            try {
              await sweepCronRunSessions({
                agentId,
                defaultAgentId,
                cronConfig: state.deps.cronConfig,
                sessionStorePath: storePath,
                nowMs,
                log: state.deps.log,
              });
            } catch (err) {
              state.deps.log.warn(
                { err: String(err), storePath },
                "cron: session reaper sweep failed",
              );
            }
          }
        }
      }
    } catch (err) {
      state.deps.log.warn({ err: String(err) }, "cron: session reaper preparation failed");
    } finally {
      state.running = false;
      armTimer(state);
    }
  }
}
