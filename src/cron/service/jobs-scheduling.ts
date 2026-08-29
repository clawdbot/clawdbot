/** Scheduling state and next-run computation for cron jobs. */
import crypto from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { formatErrorMessageWithCode } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { isCronJobActive } from "../active-jobs.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import { coerceFiniteScheduleNumber } from "../schedule-number.js";
import { computeNextRunAtMs, computePreviousRunAtMs } from "../schedule.js";
import { resolveCronStaggerMs } from "../stagger.js";
import { CRON_STUCK_RUN_MS } from "../store/run-receipt-store.js";
import { createCronStreamSourceIdentity, resolveCronStreamBatching } from "../stream-schedule.js";
import type { CronJob, CronSchedule } from "../types.js";
import { autoDisableCronJob } from "./auto-disable.js";
import { normalizePayloadToSystemText } from "./normalize.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";

const STAGGER_OFFSET_CACHE_MAX = 4096;
const staggerOffsetCache = new Map<string, number>();

// A matching process reservation keeps its durable queued/running marker live;
// disabled jobs additionally require force-run ownership.
function ownsCronRunMarker(
  state: CronServiceState,
  jobId: string,
  markerAtMs: number,
  requireForce = false,
): boolean {
  const reservation = state.queuedRunReservationsByJobId.get(jobId);
  return (
    reservation?.markerAtMs === markerAtMs && (!requireForce || reservation.preserveWhenDisabled)
  );
}

export function normalizeStreamScheduleBounds(schedule: CronSchedule): CronSchedule {
  if (schedule.kind !== "stream") {
    return schedule;
  }
  const resolved = resolveCronStreamBatching(schedule);
  return {
    ...schedule,
    ...(schedule.batchMs !== undefined ? { batchMs: resolved.batchMs } : {}),
    ...(schedule.maxBatchBytes !== undefined ? { maxBatchBytes: resolved.maxBatchBytes } : {}),
  };
}

/** Default retry delays applied after consecutive cron execution errors. */
export const DEFAULT_ERROR_BACKOFF_SCHEDULE_MS = [
  30_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
];

function isFiniteTimestamp(value: unknown): value is number {
  return asDateTimestampMs(value) !== undefined;
}

/** Returns whether a stored next-run timestamp is finite and schedulable. */
export function hasScheduledNextRunAtMs(value: unknown): value is number {
  return isFiniteTimestamp(value) && value > 0;
}

/** Resolves the newest persisted cron run status while older state is still readable. */
export function resolveJobLastRunStatus(job: Pick<CronJob, "state">) {
  return job.state.lastRunStatus ?? job.state.lastStatus;
}

/** Resolves the retry backoff delay for a one-based consecutive error count. */
export function errorBackoffMs(
  consecutiveErrors: number,
  scheduleMs = DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
): number {
  const idx = Math.min(consecutiveErrors - 1, scheduleMs.length - 1);
  return (
    expectDefined(scheduleMs[Math.max(0, idx)], "schedule ms entry at math.max(0, idx)") ??
    DEFAULT_ERROR_BACKOFF_SCHEDULE_MS[0]
  );
}

/** Returns the earliest retry timestamp after a failed cron run and its runtime duration. */
export function resolveJobErrorBackoffUntilMs(
  job: CronJob,
  scheduleMs = DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
): number | undefined {
  if (resolveJobLastRunStatus(job) !== "error" || !isFiniteTimestamp(job.state.lastRunAtMs)) {
    return undefined;
  }
  const consecutiveErrorsRaw = job.state.consecutiveErrors;
  const consecutiveErrors =
    typeof consecutiveErrorsRaw === "number" && Number.isFinite(consecutiveErrorsRaw)
      ? Math.max(1, Math.floor(consecutiveErrorsRaw))
      : 1;
  const lastDurationMs =
    typeof job.state.lastDurationMs === "number" && Number.isFinite(job.state.lastDurationMs)
      ? Math.max(0, Math.floor(job.state.lastDurationMs))
      : 0;
  const lastEndedAtMs = job.state.lastRunAtMs + lastDurationMs;
  return asDateTimestampMs(lastEndedAtMs + errorBackoffMs(consecutiveErrors, scheduleMs));
}

function resolveStableCronOffsetMs(jobId: string, staggerMs: number) {
  if (staggerMs <= 1) {
    return 0;
  }
  const cacheKey = `${staggerMs}:${jobId}`;
  const cached = staggerOffsetCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const digest = crypto.createHash("sha256").update(jobId).digest();
  const offset = digest.readUInt32BE(0) % staggerMs;
  // The offset is deterministic, so FIFO eviction does not change future scheduling semantics.
  pruneMapToMaxSize(staggerOffsetCache, STAGGER_OFFSET_CACHE_MAX - 1);
  staggerOffsetCache.set(cacheKey, offset);
  return offset;
}

function computeStaggeredCronNextRunAtMs(job: CronJob, nowMs: number) {
  if (job.schedule.kind !== "cron") {
    return computeNextRunAtMs(job.schedule, nowMs);
  }

  const staggerMs = resolveCronStaggerMs(job.schedule);
  const offsetMs = resolveStableCronOffsetMs(job.id, staggerMs);
  if (offsetMs <= 0) {
    return computeNextRunAtMs(job.schedule, nowMs);
  }

  // Shift the schedule cursor backwards by the per-job offset so we can still
  // target the current schedule window if its staggered slot has not passed yet.
  let cursorMs = Math.max(0, nowMs - offsetMs);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const baseNext = computeNextRunAtMs(job.schedule, cursorMs);
    if (baseNext === undefined) {
      return undefined;
    }
    const shifted = baseNext + offsetMs;
    if (isFiniteTimestamp(shifted) && shifted > nowMs) {
      return shifted;
    }
    cursorMs = Math.max(cursorMs + 1, baseNext + 1_000);
  }
  return undefined;
}

function computeStaggeredCronPreviousRunAtMs(job: CronJob, nowMs: number) {
  if (job.schedule.kind !== "cron") {
    return undefined;
  }

  const staggerMs = resolveCronStaggerMs(job.schedule);
  const offsetMs = resolveStableCronOffsetMs(job.id, staggerMs);
  if (offsetMs <= 0) {
    return computePreviousRunAtMs(job.schedule, nowMs);
  }

  // Shift the cursor backwards by the same per-job offset used for next-run
  // math so previous-run lookup matches the effective staggered schedule.
  let cursorMs = Math.max(0, nowMs - offsetMs);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const basePrevious = computePreviousRunAtMs(job.schedule, cursorMs);
    if (basePrevious === undefined) {
      return undefined;
    }
    const shifted = basePrevious + offsetMs;
    if (isFiniteTimestamp(shifted) && shifted <= nowMs) {
      return shifted;
    }
    cursorMs = Math.max(0, basePrevious - 1_000);
  }
  return undefined;
}

function computeStaggeredCronPreviousRunAtOrBeforeMs(job: CronJob, nowMs: number) {
  const previous = computeStaggeredCronPreviousRunAtMs(job, nowMs);
  const probeMs = nowMs + 1_000;
  if (!isFiniteTimestamp(probeMs)) {
    return previous;
  }

  // Croner previous-run queries are strict-before and second-granular. Keep
  // the strict result, then probe past the current second to include a slot
  // exactly at now without losing the prior slot between boundaries.
  const boundary = computeStaggeredCronPreviousRunAtMs(job, probeMs);
  if (
    isFiniteTimestamp(boundary) &&
    boundary <= nowMs &&
    (!isFiniteTimestamp(previous) || boundary > previous)
  ) {
    return boundary;
  }
  return previous;
}

function isStaggeredCronRunAtMs(job: CronJob, runAtMs: number): boolean {
  if (job.schedule.kind !== "cron" || !isFiniteTimestamp(runAtMs)) {
    return false;
  }
  const previous = computeStaggeredCronPreviousRunAtOrBeforeMs(job, runAtMs);
  return previous === runAtMs;
}

function isPendingErrorBackoffSlot(params: {
  job: CronJob;
  nextRunAtMs: number;
  nowMs: number;
}): boolean {
  const { job, nextRunAtMs, nowMs } = params;
  const backoffUntilMs = resolveJobErrorBackoffUntilMs(job, DEFAULT_ERROR_BACKOFF_SCHEDULE_MS);
  return backoffUntilMs !== undefined && nowMs < backoffUntilMs && nextRunAtMs <= backoffUntilMs;
}

function shouldRepairFutureCronNextRunAtMs(params: { job: CronJob; nowMs: number }): boolean {
  const { job, nowMs } = params;
  const nextRun = job.state.nextRunAtMs;
  if (
    job.schedule.kind !== "cron" ||
    !hasScheduledNextRunAtMs(nextRun) ||
    nowMs >= nextRun ||
    typeof job.state.queuedAtMs === "number" ||
    typeof job.state.runningAtMs === "number"
  ) {
    return false;
  }

  // Error retries may intentionally use a non-cron future timestamp while
  // backoff is pending. Once the retry window has elapsed, stale future cron
  // slots should be eligible for the same repair as ordinary schedule state.
  if (isPendingErrorBackoffSlot({ job, nextRunAtMs: nextRun, nowMs })) {
    return false;
  }
  let naturalNext: number | undefined;
  try {
    naturalNext = computeStaggeredCronNextRunAtMs(job, nowMs);
  } catch {
    return false;
  }
  if (!isFiniteTimestamp(naturalNext)) {
    return false;
  }
  let isScheduledSlot;
  try {
    isScheduledSlot = isStaggeredCronRunAtMs(job, nextRun);
  } catch {
    return false;
  }
  if (isScheduledSlot) {
    return false;
  }
  if (nextRun < naturalNext) {
    return job.payload.kind !== "agentTurn";
  }
  if (nextRun === naturalNext) {
    return false;
  }

  let followingNaturalNext: number | undefined;
  try {
    followingNaturalNext = computeStaggeredCronNextRunAtMs(job, naturalNext);
  } catch {
    return false;
  }
  if (!isFiniteTimestamp(followingNaturalNext)) {
    return false;
  }
  const naturalIntervalMs = followingNaturalNext - naturalNext;
  return naturalIntervalMs > 0 && nextRun >= followingNaturalNext + naturalIntervalMs;
}

export function resolveEveryAnchorMs(params: {
  schedule: { everyMs: number; anchorMs?: number };
  fallbackAnchorMs: number;
}) {
  const coerced = coerceFiniteScheduleNumber(params.schedule.anchorMs);
  if (coerced !== undefined) {
    return Math.max(0, Math.floor(coerced));
  }
  if (isFiniteTimestamp(params.fallbackAnchorMs)) {
    return Math.max(0, Math.floor(params.fallbackAnchorMs));
  }
  return 0;
}

function hasInvalidExplicitEveryAnchor(schedule: { anchorMs?: number }): boolean {
  if (schedule.anchorMs === undefined) {
    return false;
  }
  const coerced = coerceFiniteScheduleNumber(schedule.anchorMs);
  return coerced === undefined || coerced < 0;
}

/** Finds an in-memory cron job or throws the public unknown-id error. */
export function findJobOrThrow(state: CronServiceState, id: string) {
  const job = state.store?.jobs.find((j) => j.id === id);
  if (!job) {
    throw new Error(`unknown cron job id: ${id}`);
  }
  return job;
}

/** Returns the effective enabled flag, defaulting missing values to enabled. */
export function isJobEnabled(job: Pick<CronJob, "enabled">): boolean {
  return job.enabled ?? true;
}

/** Computes the next run timestamp for enabled jobs across every/at/cron schedules. */
export function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined {
  if (!isJobEnabled(job)) {
    return undefined;
  }
  if (job.schedule.kind === "every") {
    if (hasInvalidExplicitEveryAnchor(job.schedule)) {
      return undefined;
    }
    const everyMsRaw = coerceFiniteScheduleNumber(job.schedule.everyMs);
    if (everyMsRaw === undefined) {
      return undefined;
    }
    const everyMs = Math.floor(everyMsRaw);
    if (everyMs < 1) {
      return undefined;
    }
    const fallbackAnchorMs = isFiniteTimestamp(job.createdAtMs) ? job.createdAtMs : nowMs;
    const anchorMs = resolveEveryAnchorMs({
      schedule: job.schedule,
      fallbackAnchorMs,
    });
    const lastRunAtMs = job.state.lastRunAtMs;
    if (isFiniteTimestamp(lastRunAtMs) && lastRunAtMs >= anchorMs) {
      const nextFromLastRun = Math.floor(lastRunAtMs) + everyMs;
      if (!isFiniteTimestamp(nextFromLastRun)) {
        return undefined;
      }
      if (nextFromLastRun > nowMs) {
        return nextFromLastRun;
      }
    }
    const next = computeNextRunAtMs({ ...job.schedule, everyMs, anchorMs }, nowMs);
    return isFiniteTimestamp(next) ? next : undefined;
  }
  if (job.schedule.kind === "at") {
    const atMs = parseAbsoluteTimeMs(job.schedule.at);
    // One-shot jobs stay due until they successfully finish, but if the
    // schedule was updated to a time after the last run, re-arm the job.
    if (resolveJobLastRunStatus(job) === "ok" && job.state.lastRunAtMs) {
      if (atMs !== null && Number.isFinite(atMs) && atMs > job.state.lastRunAtMs) {
        return atMs;
      }
      return undefined;
    }
    return atMs !== null && Number.isFinite(atMs) ? atMs : undefined;
  }
  const next = computeStaggeredCronNextRunAtMs(job, nowMs);
  if (next === undefined && job.schedule.kind === "cron") {
    const nextSecondMs = Math.floor(nowMs / 1000) * 1000 + 1000;
    return computeStaggeredCronNextRunAtMs(job, nextSecondMs);
  }
  return isFiniteTimestamp(next) ? next : undefined;
}

/** Computes the latest effective cron timestamp at or before the supplied time. */
export function computeJobPreviousRunAtOrBeforeMs(job: CronJob, nowMs: number): number | undefined {
  if (!isJobEnabled(job) || job.schedule.kind !== "cron") {
    return undefined;
  }
  const previous = computeStaggeredCronPreviousRunAtOrBeforeMs(job, nowMs);
  return isFiniteTimestamp(previous) ? previous : undefined;
}

/** Maximum consecutive schedule errors before auto-disabling a job. */
const MAX_SCHEDULE_ERRORS = 3;

/** Records a schedule-computation failure and auto-disables after repeated errors. */
export function recordScheduleComputeError(params: {
  state: CronServiceState;
  job: CronJob;
  err: unknown;
  deferredNotifications?: DeferredCronNotifications;
}): boolean {
  const { state, job, err } = params;
  const errorCount = (job.state.scheduleErrorCount ?? 0) + 1;
  const errText = formatErrorMessageWithCode(err);

  job.state.scheduleErrorCount = errorCount;
  job.state.nextRunAtMs = undefined;
  job.state.lastError = `schedule error: ${errText}`;

  if (errorCount >= MAX_SCHEDULE_ERRORS) {
    autoDisableCronJob({
      state,
      job,
      reason: "schedule-errors",
      atMs: state.deps.nowMs(),
      consecutiveErrors: errorCount,
      deferredNotifications: params.deferredNotifications,
    });
    state.deps.log.error(
      { jobId: job.id, name: job.name, errorCount, err: errText },
      "cron: auto-disabled job after repeated schedule errors",
    );
  } else {
    state.deps.log.warn(
      { jobId: job.id, name: job.name, errorCount, err: errText },
      "cron: failed to compute next run for job (skipping)",
    );
  }

  return true;
}

function normalizeJobTickState(params: { state: CronServiceState; job: CronJob; nowMs: number }): {
  changed: boolean;
  skip: boolean;
} {
  const { state, job, nowMs } = params;
  let changed = false;

  if (!job.state) {
    job.state = {};
    changed = true;
  }

  if (job.schedule.kind === "stream" && !job.state.streamSourceIdentity?.trim()) {
    // Identity is store-owned state. A hand-imported or pre-identity row must
    // not reach the watcher (which fails closed on a missing identity) or
    // admission (which would reject every batch); assign one like any other
    // repairable tick state.
    job.state.streamSourceIdentity = createCronStreamSourceIdentity();
    changed = true;
  }

  if (job.schedule.kind === "every" && !hasInvalidExplicitEveryAnchor(job.schedule)) {
    const normalizedAnchorMs = resolveEveryAnchorMs({
      schedule: job.schedule,
      fallbackAnchorMs: isFiniteTimestamp(job.createdAtMs) ? job.createdAtMs : nowMs,
    });
    if (job.schedule.anchorMs !== normalizedAnchorMs) {
      job.schedule = {
        ...job.schedule,
        anchorMs: normalizedAnchorMs,
      };
      job.state.pacedNextRunAtMs = undefined;
      job.state.forcePreservedNextRunAtMs = undefined;
      changed = true;
    }
  }

  if (!isJobEnabled(job)) {
    for (const key of [
      "startupCatchupAtMs",
      "pacedNextRunAtMs",
      "forcePreservedNextRunAtMs",
      "nextRunAtMs",
    ] as const) {
      if (job.state[key] !== undefined) {
        job.state[key] = undefined;
        changed = true;
      }
    }
    if (
      job.state.queuedAtMs !== undefined &&
      !ownsCronRunMarker(state, job.id, job.state.queuedAtMs, true)
    ) {
      job.state.queuedAtMs = undefined;
      changed = true;
    }
    if (
      job.state.runningAtMs !== undefined &&
      !ownsCronRunMarker(state, job.id, job.state.runningAtMs, true) &&
      !isCronJobActive(job.id)
    ) {
      job.state.runningAtMs = undefined;
      changed = true;
    }
    return { changed, skip: true };
  }

  if (!hasScheduledNextRunAtMs(job.state.nextRunAtMs) && job.state.nextRunAtMs !== undefined) {
    job.state.nextRunAtMs = undefined;
    changed = true;
  }

  const forcePreservedNextRunAtMs = job.state.forcePreservedNextRunAtMs;
  if (
    forcePreservedNextRunAtMs !== undefined &&
    (!isFiniteTimestamp(forcePreservedNextRunAtMs) ||
      forcePreservedNextRunAtMs !== job.state.nextRunAtMs)
  ) {
    job.state.forcePreservedNextRunAtMs = undefined;
    changed = true;
  }

  const queuedAt = job.state.queuedAtMs;
  if (
    typeof queuedAt === "number" &&
    Math.abs(nowMs - queuedAt) > CRON_STUCK_RUN_MS &&
    !ownsCronRunMarker(state, job.id, queuedAt)
  ) {
    state.deps.log.warn(
      { jobId: job.id, queuedAtMs: queuedAt },
      "cron: clearing stuck queued marker",
    );
    job.state.queuedAtMs = undefined;
    changed = true;
  }

  const runningAt = job.state.runningAtMs;
  if (
    typeof runningAt === "number" &&
    Math.abs(nowMs - runningAt) > CRON_STUCK_RUN_MS &&
    !ownsCronRunMarker(state, job.id, runningAt)
  ) {
    state.deps.log.warn(
      { jobId: job.id, runningAtMs: runningAt },
      "cron: clearing stuck running marker",
    );
    job.state.runningAtMs = undefined;
    changed = true;
    const nextRun = job.state.nextRunAtMs;
    const lastRun = job.state.lastRunAtMs;
    const alreadyExecutedSlot =
      hasScheduledNextRunAtMs(nextRun) && isFiniteTimestamp(lastRun) && lastRun >= nextRun;
    return { changed, skip: !alreadyExecutedSlot };
  }

  return { changed, skip: false };
}

function walkSchedulableJobs(
  state: CronServiceState,
  fn: (params: { job: CronJob; nowMs: number }) => boolean,
  nowMs = state.deps.nowMs(),
): boolean {
  if (!state.store) {
    return false;
  }
  let changed = false;
  for (const job of state.store.jobs) {
    const tick = normalizeJobTickState({ state, job, nowMs });
    if (tick.changed) {
      changed = true;
    }
    if (tick.skip) {
      continue;
    }
    if (fn({ job, nowMs })) {
      changed = true;
    }
  }
  return changed;
}

export function recomputeJobNextRunAtMs(params: {
  state: CronServiceState;
  job: CronJob;
  nowMs: number;
  deferredNotifications?: DeferredCronNotifications;
  skipScheduleErrorHandling?: boolean;
}) {
  let changed = false;
  try {
    let newNext = computeJobNextRunAtMs(params.job, params.nowMs);
    if (
      params.job.schedule.kind !== "at" &&
      resolveJobLastRunStatus(params.job) === "error" &&
      isFiniteTimestamp(params.job.state.lastRunAtMs)
    ) {
      const backoffFloor = resolveJobErrorBackoffUntilMs(
        params.job,
        DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
      );
      if (newNext !== undefined) {
        newNext = backoffFloor !== undefined ? Math.max(newNext, backoffFloor) : newNext;
      }
    }
    if (params.job.state.nextRunAtMs !== newNext) {
      params.job.state.nextRunAtMs = newNext;
      changed = true;
    }
    // Clear schedule error count on successful computation.
    if (params.job.state.scheduleErrorCount) {
      params.job.state.scheduleErrorCount = undefined;
      changed = true;
    }
  } catch (err) {
    if (params.skipScheduleErrorHandling) {
      return false;
    }
    if (
      recordScheduleComputeError({
        state: params.state,
        job: params.job,
        err,
        deferredNotifications: params.deferredNotifications,
      })
    ) {
      changed = true;
    }
  }
  return changed;
}

/** Recomputes missing, due, or repairable next-run timestamps for all schedulable jobs. */
export function recomputeNextRuns(state: CronServiceState): boolean {
  return walkSchedulableJobs(state, ({ job, nowMs: now }) => {
    // Only recompute if nextRunAtMs is missing or already past-due.
    // Preserving a still-future nextRunAtMs avoids accidentally advancing
    // a job that hasn't fired yet (e.g. during restart recovery).
    const nextRun = job.state.nextRunAtMs;
    const hasForcePreservedNextRun =
      isFiniteTimestamp(job.state.forcePreservedNextRunAtMs) &&
      hasScheduledNextRunAtMs(nextRun) &&
      job.state.forcePreservedNextRunAtMs === nextRun;
    const isDueOrMissing = !hasScheduledNextRunAtMs(nextRun) || now >= nextRun;
    return (
      !hasForcePreservedNextRun &&
      (isDueOrMissing || shouldRepairFutureCronNextRunAtMs({ job, nowMs: now })) &&
      recomputeJobNextRunAtMs({ state, job, nowMs: now })
    );
  });
}

/**
 * Maintenance-only version of recomputeNextRuns that handles disabled jobs
 * and stuck markers, but does NOT recompute nextRunAtMs for enabled jobs
 * with existing values. Used during timer ticks when no due jobs were found
 * to prevent silently advancing past-due nextRunAtMs values without execution
 * (see #13992).
 */
export type CronMaintenanceOptions = {
  recomputeExpired?: boolean;
  nowMs?: number;
  repairFutureCronNextRunAtMs?: boolean;
  preserveExpiredPacedNextRunJobId?: string;
  deferredNotifications?: DeferredCronNotifications;
  skipScheduleErrorHandling?: boolean;
};

export function recomputeSingleJobForMaintenance(
  state: CronServiceState,
  job: CronJob,
  opts?: CronMaintenanceOptions,
): boolean {
  const now = opts?.nowMs ?? state.deps.nowMs();
  const tick = normalizeJobTickState({ state, job, nowMs: now });
  let changed = tick.changed;
  if (tick.skip) {
    return changed;
  }
  const recomputeExpired = opts?.recomputeExpired ?? false;
  const repairFutureCronNextRunAtMs = opts?.repairFutureCronNextRunAtMs ?? true;
  const recomputeJob = () =>
    recomputeJobNextRunAtMs({
      state,
      job,
      nowMs: now,
      deferredNotifications: opts?.deferredNotifications,
      skipScheduleErrorHandling: opts?.skipScheduleErrorHandling,
    });
  const startupCatchupAtMs = job.state.startupCatchupAtMs;
  const pacedNextRunAtMs = job.state.pacedNextRunAtMs;
  const nextRunAtMs = job.state.nextRunAtMs;
  const hasForcePreservedNextRun =
    isFiniteTimestamp(job.state.forcePreservedNextRunAtMs) &&
    hasScheduledNextRunAtMs(nextRunAtMs) &&
    job.state.forcePreservedNextRunAtMs === nextRunAtMs;
  const hasPendingStartupCatchup =
    isFiniteTimestamp(startupCatchupAtMs) &&
    hasScheduledNextRunAtMs(nextRunAtMs) &&
    startupCatchupAtMs === nextRunAtMs;
  if (startupCatchupAtMs !== undefined && !hasPendingStartupCatchup) {
    job.state.startupCatchupAtMs = undefined;
    changed = true;
  }
  const hasPendingPacedNextRun =
    isFiniteTimestamp(pacedNextRunAtMs) &&
    hasScheduledNextRunAtMs(nextRunAtMs) &&
    pacedNextRunAtMs === nextRunAtMs &&
    (now < pacedNextRunAtMs || opts?.preserveExpiredPacedNextRunJobId === job.id);
  if (pacedNextRunAtMs !== undefined && !hasPendingPacedNextRun) {
    job.state.pacedNextRunAtMs = undefined;
    changed = true;
  }

  if (!hasScheduledNextRunAtMs(job.state.nextRunAtMs)) {
    changed = recomputeJob() || changed;
  } else if (
    repairFutureCronNextRunAtMs &&
    !hasPendingStartupCatchup &&
    !hasPendingPacedNextRun &&
    !hasForcePreservedNextRun &&
    shouldRepairFutureCronNextRunAtMs({ job, nowMs: now })
  ) {
    changed = recomputeJob() || changed;
  } else if (
    recomputeExpired &&
    !hasPendingStartupCatchup &&
    !hasForcePreservedNextRun &&
    now >= job.state.nextRunAtMs &&
    typeof job.state.queuedAtMs !== "number" &&
    typeof job.state.runningAtMs !== "number"
  ) {
    const lastRun = job.state.lastRunAtMs;
    const alreadyExecutedSlot = isFiniteTimestamp(lastRun) && lastRun >= job.state.nextRunAtMs;
    const backoffUntilMs = resolveJobErrorBackoffUntilMs(job, DEFAULT_ERROR_BACKOFF_SCHEDULE_MS);
    const isStaleBackoffSlot =
      backoffUntilMs !== undefined &&
      now < backoffUntilMs &&
      job.state.nextRunAtMs < backoffUntilMs;
    if (alreadyExecutedSlot || isStaleBackoffSlot) {
      changed = recomputeJob() || changed;
    }
  }
  return changed;
}

export function recomputeNextRunsForMaintenance(
  state: CronServiceState,
  opts?: CronMaintenanceOptions,
): boolean {
  if (!state.store) {
    return false;
  }
  let changed = false;
  for (const job of state.store.jobs) {
    changed = recomputeSingleJobForMaintenance(state, job, opts) || changed;
  }
  return changed;
}

/** Summarizes the resident job schedule in one pass for timer and status projections. */
export function summarizeCronJobSchedule(state: CronServiceState) {
  const jobs = state.store?.jobs ?? [];
  let nextWake: number | undefined;
  let jobCount = 0;
  let enabledCount = 0;
  let runnableCount = 0;
  for (const job of jobs) {
    jobCount += 1;
    const nextRun = job.state.nextRunAtMs;
    const hasNextRun = hasScheduledNextRunAtMs(nextRun);
    const rawEnabled = job.enabled;
    // Timer diagnostics historically count only explicit enablement, while
    // wake selection keeps older jobs without `enabled` runnable.
    if (rawEnabled) {
      enabledCount += 1;
    }
    if (rawEnabled ?? true) {
      runnableCount += 1;
    }
    if ((rawEnabled ?? true) && hasNextRun) {
      nextWake = nextWake === undefined ? nextRun : Math.min(nextWake, nextRun);
    }
  }
  return {
    jobCount,
    enabledCount,
    runnableCount,
    nextWakeAtMs: nextWake,
  };
}

/** Returns the next enabled wake timestamp from the in-memory cron store. */
export function nextWakeAtMs(state: CronServiceState) {
  return summarizeCronJobSchedule(state).nextWakeAtMs;
}

/** Applies one canonical server-authored authority envelope to a tool-bearing job. */
export function hasActiveCronRun(job: Pick<CronJob, "id" | "state">) {
  return (
    typeof job.state.queuedAtMs === "number" ||
    typeof job.state.runningAtMs === "number" ||
    isCronJobActive(job.id)
  );
}

/** Returns whether a cron job should execute at `nowMs`, honoring force mode and active runs. */
export function isJobDue(job: CronJob, nowMs: number, opts: { forced: boolean }) {
  if (!job.state) {
    job.state = {};
  }
  if (hasActiveCronRun(job)) {
    return false;
  }
  if (opts.forced) {
    return true;
  }
  return (
    isJobEnabled(job) &&
    hasScheduledNextRunAtMs(job.state.nextRunAtMs) &&
    nowMs >= job.state.nextRunAtMs
  );
}

/** Returns main-session queue text for system-event jobs, or undefined when empty/unsupported. */
export function resolveJobPayloadTextForMain(job: CronJob): string | undefined {
  if (job.payload.kind !== "systemEvent") {
    return undefined;
  }
  const text = normalizePayloadToSystemText(job.payload);
  return text.trim() ? text : undefined;
}
