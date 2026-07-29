/** Scheduling state and next-run computation for cron jobs. */
import crypto from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { isCronJobActive } from "../active-jobs.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import {
  coerceFiniteScheduleNumber,
  computeNextRunAtMs,
  computePreviousRunAtMs,
} from "../schedule.js";
import { resolveCronStaggerMs } from "../stagger.js";
import { createCronStreamSourceIdentity, resolveCronStreamBatching } from "../stream-schedule.js";
import type { CronJob, CronSchedule } from "../types.js";
import { normalizePayloadToSystemText } from "./normalize.js";
import { isQueuedCronRun, isQueuedForceCronRun } from "./run-admission.js";
import type { CronServiceState } from "./state.js";

const STUCK_RUN_MS = 2 * 60 * 60 * 1000;
const STAGGER_OFFSET_CACHE_MAX = 4096;
const staggerOffsetCache = new Map<string, number>();

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
  return typeof value === "number" && Number.isFinite(value);
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
  return lastEndedAtMs + errorBackoffMs(consecutiveErrors, scheduleMs);
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
  if (staggerOffsetCache.size >= STAGGER_OFFSET_CACHE_MAX) {
    // The offset is deterministic, so the cache can evict oldest entries
    // without changing scheduling semantics for future lookups.
    const first = staggerOffsetCache.keys().next();
    if (!first.done) {
      staggerOffsetCache.delete(first.value);
    }
  }
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
    if (shifted > nowMs) {
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
    if (shifted <= nowMs) {
      return shifted;
    }
    cursorMs = Math.max(0, basePrevious - 1_000);
  }
  return undefined;
}

function computeStaggeredCronPreviousRunAtOrBeforeMs(job: CronJob, nowMs: number) {
  const previous = computeStaggeredCronPreviousRunAtMs(job, nowMs);
  const probeMs = nowMs + 1_000;
  if (!Number.isFinite(probeMs)) {
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
  state: CronServiceState;
  job: CronJob;
  nextRunAtMs: number;
  nowMs: number;
}): boolean {
  const { job, nextRunAtMs, nowMs } = params;
  const backoffUntilMs = resolveJobErrorBackoffUntilMs(job, DEFAULT_ERROR_BACKOFF_SCHEDULE_MS);
  return backoffUntilMs !== undefined && nowMs < backoffUntilMs && nextRunAtMs <= backoffUntilMs;
}

function shouldRepairFutureCronNextRunAtMs(params: {
  state: CronServiceState;
  job: CronJob;
  nowMs: number;
}): boolean {
  const { state, job, nowMs } = params;
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
  if (isPendingErrorBackoffSlot({ state, job, nextRunAtMs: nextRun, nowMs })) {
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
    const everyMsRaw = coerceFiniteScheduleNumber(job.schedule.everyMs);
    if (everyMsRaw === undefined) {
      return undefined;
    }
    const everyMs = Math.max(1, Math.floor(everyMsRaw));
    const lastRunAtMs = job.state.lastRunAtMs;
    if (typeof lastRunAtMs === "number" && Number.isFinite(lastRunAtMs)) {
      const nextFromLastRun = Math.floor(lastRunAtMs) + everyMs;
      if (nextFromLastRun > nowMs) {
        return nextFromLastRun;
      }
    }
    const fallbackAnchorMs = isFiniteTimestamp(job.createdAtMs) ? job.createdAtMs : nowMs;
    const anchorMs = resolveEveryAnchorMs({
      schedule: job.schedule,
      fallbackAnchorMs,
    });
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

/** Computes the previous effective cron timestamp, including per-job staggering. */
export function computeJobPreviousRunAtMs(job: CronJob, nowMs: number): number | undefined {
  if (!isJobEnabled(job) || job.schedule.kind !== "cron") {
    return undefined;
  }
  const previous = computeStaggeredCronPreviousRunAtMs(job, nowMs);
  return isFiniteTimestamp(previous) ? previous : undefined;
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
  deferredAutoDisableNotifications?: Array<() => void>;
}): boolean {
  const { state, job, err } = params;
  const errorCount = (job.state.scheduleErrorCount ?? 0) + 1;
  const errText = String(err);

  job.state.scheduleErrorCount = errorCount;
  job.state.nextRunAtMs = undefined;
  job.state.lastError = `schedule error: ${errText}`;

  if (errorCount >= MAX_SCHEDULE_ERRORS) {
    job.enabled = false;
    state.deps.log.error(
      { jobId: job.id, name: job.name, errorCount, err: errText },
      "cron: auto-disabled job after repeated schedule errors",
    );

    const notifyText = `⚠️ Cron job "${job.name}" has been auto-disabled after ${errorCount} consecutive schedule errors. Last error: ${errText}`;
    const notify = () => {
      state.deps.enqueueSystemEvent(notifyText, {
        agentId: job.agentId,
        sessionKey: job.sessionKey,
        contextKey: `cron:${job.id}:auto-disabled`,
      });
      state.deps.requestHeartbeat({
        source: "cron",
        intent: "event",
        reason: `cron:${job.id}:auto-disabled`,
        agentId: job.agentId,
        sessionKey: job.sessionKey,
      });
    };
    if (params.deferredAutoDisableNotifications) {
      params.deferredAutoDisableNotifications.push(notify);
    } else {
      // Notify the user so the auto-disable is not silent (#28861).
      notify();
    }
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

  if (job.schedule.kind === "every") {
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
    if (job.state.startupCatchupAtMs !== undefined) {
      job.state.startupCatchupAtMs = undefined;
      changed = true;
    }
    if (job.state.pacedNextRunAtMs !== undefined) {
      job.state.pacedNextRunAtMs = undefined;
      changed = true;
    }
    if (job.state.forcePreservedNextRunAtMs !== undefined) {
      job.state.forcePreservedNextRunAtMs = undefined;
      changed = true;
    }
    if (job.state.nextRunAtMs !== undefined) {
      job.state.nextRunAtMs = undefined;
      changed = true;
    }
    if (
      job.state.queuedAtMs !== undefined &&
      !isQueuedForceCronRun(state, job.id, job.state.queuedAtMs)
    ) {
      job.state.queuedAtMs = undefined;
      changed = true;
    }
    if (
      job.state.runningAtMs !== undefined &&
      !isQueuedForceCronRun(state, job.id, job.state.runningAtMs) &&
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
    Math.abs(nowMs - queuedAt) > STUCK_RUN_MS &&
    !isQueuedCronRun(state, job.id, queuedAt)
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
    Math.abs(nowMs - runningAt) > STUCK_RUN_MS &&
    !isQueuedCronRun(state, job.id, runningAt)
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

function recomputeJobNextRunAtMs(params: {
  state: CronServiceState;
  job: CronJob;
  nowMs: number;
  deferredAutoDisableNotifications?: Array<() => void>;
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
    if (
      recordScheduleComputeError({
        state: params.state,
        job: params.job,
        err,
        deferredAutoDisableNotifications: params.deferredAutoDisableNotifications,
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
    let changed = false;
    // Only recompute if nextRunAtMs is missing or already past-due.
    // Preserving a still-future nextRunAtMs avoids accidentally advancing
    // a job that hasn't fired yet (e.g. during restart recovery).
    const nextRun = job.state.nextRunAtMs;
    const hasForcePreservedNextRun =
      isFiniteTimestamp(job.state.forcePreservedNextRunAtMs) &&
      hasScheduledNextRunAtMs(nextRun) &&
      job.state.forcePreservedNextRunAtMs === nextRun;
    const isDueOrMissing = !hasScheduledNextRunAtMs(nextRun) || now >= nextRun;
    if (
      !hasForcePreservedNextRun &&
      (isDueOrMissing || shouldRepairFutureCronNextRunAtMs({ state, job, nowMs: now }))
    ) {
      if (recomputeJobNextRunAtMs({ state, job, nowMs: now })) {
        changed = true;
      }
    }
    return changed;
  });
}

/**
 * Maintenance-only version of recomputeNextRuns that handles disabled jobs
 * and stuck markers, but does NOT recompute nextRunAtMs for enabled jobs
 * with existing values. Used during timer ticks when no due jobs were found
 * to prevent silently advancing past-due nextRunAtMs values without execution
 * (see #13992).
 */
export function recomputeNextRunsForMaintenance(
  state: CronServiceState,
  opts?: {
    recomputeExpired?: boolean;
    nowMs?: number;
    repairFutureCronNextRunAtMs?: boolean;
    preserveExpiredPacedNextRunJobId?: string;
    deferredAutoDisableNotifications?: Array<() => void>;
  },
): boolean {
  const recomputeExpired = opts?.recomputeExpired ?? false;
  const repairFutureCronNextRunAtMs = opts?.repairFutureCronNextRunAtMs ?? true;
  const recomputeJob = (job: CronJob, nowMs: number) =>
    recomputeJobNextRunAtMs({
      state,
      job,
      nowMs,
      deferredAutoDisableNotifications: opts?.deferredAutoDisableNotifications,
    });
  return walkSchedulableJobs(
    state,
    ({ job, nowMs: now }) => {
      let changed = false;

      const startupCatchupAtMs = job.state.startupCatchupAtMs;
      const pacedNextRunAtMs = job.state.pacedNextRunAtMs;
      const nextRunAtMs = job.state.nextRunAtMs;
      const hasForcePreservedNextRun =
        isFiniteTimestamp(job.state.forcePreservedNextRunAtMs) &&
        hasScheduledNextRunAtMs(nextRunAtMs) &&
        job.state.forcePreservedNextRunAtMs === nextRunAtMs;
      // The persisted marker owns only its exact future slot. Schedule edits,
      // malformed state, or arrival at the slot release normal repair policy.
      const hasPendingStartupCatchup =
        isFiniteTimestamp(startupCatchupAtMs) &&
        hasScheduledNextRunAtMs(nextRunAtMs) &&
        startupCatchupAtMs === nextRunAtMs &&
        now < startupCatchupAtMs;
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
        if (recomputeJob(job, now)) {
          changed = true;
        }
      } else if (
        repairFutureCronNextRunAtMs &&
        !hasPendingStartupCatchup &&
        !hasPendingPacedNextRun &&
        !hasForcePreservedNextRun &&
        shouldRepairFutureCronNextRunAtMs({ state, job, nowMs: now })
      ) {
        if (recomputeJob(job, now)) {
          changed = true;
        }
      } else if (
        recomputeExpired &&
        !hasForcePreservedNextRun &&
        now >= job.state.nextRunAtMs &&
        typeof job.state.queuedAtMs !== "number" &&
        typeof job.state.runningAtMs !== "number"
      ) {
        // Only advance when the expired slot was already executed, or when
        // old start-based retry state predates the active run-end backoff.
        // Otherwise preserve the past-due value so the job can still run.
        const lastRun = job.state.lastRunAtMs;
        const alreadyExecutedSlot = isFiniteTimestamp(lastRun) && lastRun >= job.state.nextRunAtMs;
        const backoffUntilMs = resolveJobErrorBackoffUntilMs(
          job,
          DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
        );
        const isStaleBackoffSlot =
          backoffUntilMs !== undefined &&
          now < backoffUntilMs &&
          job.state.nextRunAtMs < backoffUntilMs;
        if (alreadyExecutedSlot || isStaleBackoffSlot) {
          if (recomputeJob(job, now)) {
            changed = true;
          }
        }
      }
      return changed;
    },
    opts?.nowMs,
  );
}

/** Returns the next enabled wake timestamp from the in-memory cron store. */
export function nextWakeAtMs(state: CronServiceState) {
  const jobs = state.store?.jobs ?? [];
  const enabled = jobs.filter(
    (j) => isJobEnabled(j) && hasScheduledNextRunAtMs(j.state.nextRunAtMs),
  );
  if (enabled.length === 0) {
    return undefined;
  }
  const first = enabled[0]?.state.nextRunAtMs;
  if (!hasScheduledNextRunAtMs(first)) {
    return undefined;
  }
  return enabled.reduce((min, j) => {
    const next = j.state.nextRunAtMs;
    return hasScheduledNextRunAtMs(next) ? Math.min(min, next) : min;
  }, first);
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
