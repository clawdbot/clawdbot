import { resolveCronTriggerMinIntervalMs } from "../config/cron-limits.js";
import type { CronJob, CronJobState } from "../cron/types.js";
import type { ProcessSupervisor } from "../process/supervisor/index.js";
import {
  CronStreamJobOwner,
  isCronStreamJob,
  type CronStreamOwnerParams,
  type CronStreamOwnerSnapshot,
  type CronStreamStopReason,
} from "./cron-stream-job-owner.js";
import type { CronStreamFireDisposition, CronStreamJob } from "./cron-stream-output.js";

export type { CronStreamFireDisposition } from "./cron-stream-output.js";

const MAX_RETIRED_COUNTER_SEEDS = 1_024;
const MAX_MUTATION_EPOCHS = 1_024;

type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

type CronStreamWatchers = {
  reconcile: (jobs: CronJob[], enabled: boolean, triggersEnabled?: boolean) => Promise<void>;
  resume: () => void;
  start: (job: CronJob) => Promise<void>;
  stop: (jobId: string, reason: CronStreamStopReason, job?: CronJob) => Promise<void>;
  stopAll: (reason: CronStreamStopReason) => Promise<void>;
  activeJobIds: () => string[];
  inspect: (jobId: string) => CronStreamOwnerSnapshot | undefined;
};

/** Keep direct mutations and reconcile decisions on the same stop-reason contract. */
export function resolveStreamStopReason(input: {
  triggersEnabled: boolean;
  cronEnabled: boolean;
  restartExhausted: boolean;
  isStream: boolean;
}): CronStreamStopReason {
  if (!input.triggersEnabled) {
    return "trust-disabled";
  }
  if (!input.cronEnabled) {
    return "cron-disabled";
  }
  if (input.restartExhausted) {
    return "restart-exhausted";
  }
  return input.isStream ? "disabled" : "schedule-update";
}

/** Supervise line-producing cron sources through one serialized owner per job. */
export function createCronStreamWatchers(params: {
  getProcessSupervisor: () => ProcessSupervisor;
  /** Test seams; production uses the built-in cadence and retry schedules. */
  minIntervalMs?: number;
  retryBackoffMs?: number[];
  updateState: (
    jobId: string,
    patch: Partial<CronJobState>,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ) => Promise<boolean | void>;
  retireSource: (
    jobId: string,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ) => Promise<string | undefined>;
  updateCounters?: (
    jobId: string,
    counters: Pick<CronJobState, "streamDroppedBatches" | "streamCoalescedBatches">,
  ) => Promise<void>;
  recordFailure: (
    jobId: string,
    error: string,
    patch: Partial<CronJobState>,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ) => Promise<void>;
  fireBatch: (
    job: CronJob,
    batch: string,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ) => Promise<CronStreamFireDisposition>;
  logger: Logger;
  nowMs?: () => number;
}): CronStreamWatchers {
  const owners = new Map<string, CronStreamJobOwner>();
  const retiredCounterSeeds = new Map<
    string,
    Pick<CronJobState, "streamDroppedBatches" | "streamCoalescedBatches">
  >();
  // Direct mutations fence stale per-job reconcile decisions. Tokens come from
  // one monotonic source so bounded LRU entries cannot alias before eviction.
  const mutationEpochs = new Map<string, number>();
  let nextMutationToken = 0;
  let mutationEvictionEpoch = 0;
  let reconcileEpoch = 0;
  let stopped = false;

  const mutationEpochFor = (jobId: string) => mutationEpochs.get(jobId) ?? 0;
  const bumpMutationEpoch = (jobId: string) => {
    const next = ++nextMutationToken;
    mutationEpochs.delete(jobId);
    mutationEpochs.set(jobId, next);
    while (mutationEpochs.size > MAX_MUTATION_EPOCHS) {
      const oldest = mutationEpochs.keys().next().value;
      if (oldest === undefined || oldest === jobId) {
        break;
      }
      mutationEpochs.delete(oldest);
      // Eviction changes a nonzero token back to the absent zero sentinel.
      mutationEvictionEpoch += 1;
    }
    return next;
  };

  const ownerParams: CronStreamOwnerParams = {
    getProcessSupervisor: params.getProcessSupervisor,
    minIntervalMs: params.minIntervalMs ?? resolveCronTriggerMinIntervalMs(),
    retryBackoffMs: params.retryBackoffMs,
    updateState: params.updateState,
    retireSource: params.retireSource,
    ...(params.updateCounters ? { updateCounters: params.updateCounters } : {}),
    recordFailure: params.recordFailure,
    fireBatch: params.fireBatch,
    logger: params.logger,
    nowMs: params.nowMs ?? Date.now,
  };

  const retainCounterSeed = (owner: CronStreamJobOwner): void => {
    const snapshot = owner.snapshot();
    const current = retiredCounterSeeds.get(owner.id);
    retiredCounterSeeds.delete(owner.id);
    retiredCounterSeeds.set(owner.id, {
      streamDroppedBatches: Math.max(current?.streamDroppedBatches ?? 0, snapshot.droppedBatches),
      streamCoalescedBatches: Math.max(
        current?.streamCoalescedBatches ?? 0,
        snapshot.coalescedBatches,
      ),
    });
    while (retiredCounterSeeds.size > MAX_RETIRED_COUNTER_SEEDS) {
      const oldest = retiredCounterSeeds.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      retiredCounterSeeds.delete(oldest);
    }
  };

  const createOwner = (job: CronStreamJob): CronStreamJobOwner => {
    const seed = retiredCounterSeeds.get(job.id);
    retiredCounterSeeds.delete(job.id);
    const seededJob = seed
      ? {
          ...job,
          state: {
            ...job.state,
            streamDroppedBatches: Math.max(
              job.state.streamDroppedBatches ?? 0,
              seed.streamDroppedBatches ?? 0,
            ),
            streamCoalescedBatches: Math.max(
              job.state.streamCoalescedBatches ?? 0,
              seed.streamCoalescedBatches ?? 0,
            ),
          },
        }
      : job;
    const owner = new CronStreamJobOwner(seededJob, ownerParams);
    owners.set(job.id, owner);
    return owner;
  };

  const getOrCreateOwner = async (
    job: CronStreamJob,
    isCurrent: () => boolean,
  ): Promise<CronStreamJobOwner | undefined> => {
    while (true) {
      if (!isCurrent()) {
        return undefined;
      }
      const existing = owners.get(job.id);
      if (existing?.acceptsStart()) {
        return existing;
      }
      if (!existing) {
        return createOwner(job);
      }
      // Watcher-internal disposal of an obsolete owner, not a durable removal:
      // a retiring "removed" stop would rotate the live job's identity and
      // strand the replacement built from this snapshot behind the CAS guard.
      await existing.stop("schedule-update");
      if (!isCurrent()) {
        return undefined;
      }
      if (owners.get(job.id) === existing) {
        retainCounterSeed(existing);
        owners.delete(job.id);
      }
    }
  };

  const stop = async (
    jobId: string,
    reason: CronStreamStopReason,
    job?: CronJob,
  ): Promise<void> => {
    bumpMutationEpoch(jobId);
    const streamJob = job && isCronStreamJob(job) ? job : undefined;
    const owner =
      owners.get(jobId) ?? (reason !== "removed" && streamJob ? createOwner(streamJob) : undefined);
    if (!owner) {
      return;
    }
    await owner.stop(reason, streamJob);
    if (reason === "removed" && owners.get(jobId) === owner) {
      retainCounterSeed(owner);
      owners.delete(jobId);
    }
  };

  const startOwner = async (
    job: CronJob,
    expectedMutationEpoch: number,
    expectedReconcileEpoch?: number,
  ): Promise<void> => {
    const isCurrent = () =>
      !stopped &&
      expectedMutationEpoch === mutationEpochFor(job.id) &&
      (expectedReconcileEpoch === undefined || expectedReconcileEpoch === reconcileEpoch);
    if (!isCurrent()) {
      return;
    }
    if (!isCronStreamJob(job)) {
      await stop(job.id, "schedule-update");
      return;
    }
    const owner = await getOrCreateOwner(job, isCurrent);
    if (!owner || !isCurrent()) {
      return;
    }
    await owner.start(job);
  };

  const start = async (job: CronJob): Promise<void> => {
    const expectedMutationEpoch = bumpMutationEpoch(job.id);
    await startOwner(job, expectedMutationEpoch);
  };

  // Stop with the failure contained: owner.stop() applies its synchronous
  // admission fence when called, so callers that must fence *every* source
  // (reconcile, shutdown) initiate all stops first and log stragglers instead
  // of letting one stubborn child reject the whole sweep.
  const stopOwnerLogged = async (
    owner: CronStreamJobOwner,
    reason: CronStreamStopReason,
    job?: CronStreamJob,
  ): Promise<boolean> => {
    try {
      await owner.stop(reason, job);
      return true;
    } catch (error) {
      params.logger.warn(
        { jobId: owner.id, reason, err: String(error) },
        "cron-stream: owner stop failed",
      );
      return false;
    }
  };

  const stopAll = async (reason: CronStreamStopReason): Promise<void> => {
    if (reason === "shutdown") {
      stopped = true;
      ++reconcileEpoch;
    }
    // Every stop is initiated before any await, so each owner's synchronous
    // fence and scope pre-cancel fire even when a sibling stop later rejects.
    // Settlement is a barrier: shutdown must not resolve (or reject) while any
    // owner teardown is still in flight, so failures surface only after all
    // owners settled.
    const settled = await Promise.allSettled(
      Array.from(owners.values(), (owner) => owner.stop(reason)),
    );
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "stream owner stops failed");
    }
  };

  const reconcile = async (
    jobs: CronJob[],
    enabled: boolean,
    triggersEnabled = enabled,
  ): Promise<void> => {
    const currentReconcileEpoch = ++reconcileEpoch;
    if (stopped) {
      return;
    }
    const streamJobs = jobs.filter(isCronStreamJob);
    const wantedIds = new Set(streamJobs.map((job) => job.id));
    const mutationSnapshot = new Map<string, number>();
    for (const jobId of new Set([...owners.keys(), ...wantedIds])) {
      mutationSnapshot.set(jobId, mutationEpochFor(jobId));
    }
    const snapshotEvictionEpoch = mutationEvictionEpoch;
    const jobMutationIsCurrent = (jobId: string) => {
      const current = mutationEpochFor(jobId);
      if (current !== mutationSnapshot.get(jobId)) {
        return false;
      }
      // A zero match is safe only if no bumped token was evicted since snapshot.
      return current !== 0 || snapshotEvictionEpoch === mutationEvictionEpoch;
    };

    // One failing stop must not abort the sweep: each stop is bounded, its
    // scope pre-cancel fires when initiated, and stopOwnerLogged contains the
    // rejection so every remaining owner still gets fenced and stopped. The
    // serial awaits stay: they let direct mutations interleave and win via the
    // per-job mutation epochs.
    for (const [jobId, owner] of owners.entries()) {
      if (wantedIds.has(jobId)) {
        continue;
      }
      if (stopped || currentReconcileEpoch !== reconcileEpoch) {
        return;
      }
      if (!jobMutationIsCurrent(jobId)) {
        continue;
      }
      if (await stopOwnerLogged(owner, "removed")) {
        if (owners.get(jobId) === owner) {
          retainCounterSeed(owner);
          owners.delete(jobId);
        }
      }
      if (stopped || currentReconcileEpoch !== reconcileEpoch) {
        return;
      }
    }
    if (stopped || currentReconcileEpoch !== reconcileEpoch) {
      return;
    }

    for (const job of streamJobs) {
      if (stopped || currentReconcileEpoch !== reconcileEpoch) {
        return;
      }
      if (!jobMutationIsCurrent(job.id)) {
        continue;
      }
      const owner = await getOrCreateOwner(
        job,
        () => !stopped && currentReconcileEpoch === reconcileEpoch && jobMutationIsCurrent(job.id),
      );
      if (!owner) {
        return;
      }
      if (stopped || currentReconcileEpoch !== reconcileEpoch) {
        return;
      }
      if (!jobMutationIsCurrent(job.id)) {
        continue;
      }
      const stopReason = !enabled
        ? triggersEnabled
          ? "cron-disabled"
          : "trust-disabled"
        : !job.enabled
          ? "disabled"
          : job.state.streamRestartExhausted
            ? "restart-exhausted"
            : undefined;
      if (stopReason) {
        await stopOwnerLogged(owner, stopReason, job);
        continue;
      }
      try {
        await startOwner(job, mutationSnapshot.get(job.id) ?? 0, currentReconcileEpoch);
      } catch (error) {
        // A schedule replacement can reject when the old child refuses to
        // exit; contain it like the stop branches so one stubborn source
        // cannot leave the remaining jobs unreconciled.
        params.logger.warn(
          { jobId: job.id, err: String(error) },
          "cron-stream: reconcile start failed",
        );
      }
    }
  };

  return {
    reconcile,
    resume: () => {
      stopped = false;
      ++reconcileEpoch;
    },
    start,
    stop,
    stopAll,
    activeJobIds: () =>
      Array.from(owners.values())
        .filter((owner) => {
          const state = owner.snapshot().state;
          return (
            state === "starting" ||
            state === "running" ||
            state === "stopping" ||
            state === "backoff"
          );
        })
        .map((owner) => owner.id),
    inspect: (jobId) => owners.get(jobId)?.snapshot(),
  };
}
