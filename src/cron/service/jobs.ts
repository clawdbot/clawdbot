/** Cron job scheduling, validation, creation, and patch helpers. */
import crypto from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import { resolveCronTriggerMinIntervalMs } from "../../config/cron-limits.js";
import type { CronConfig } from "../../config/types.cron.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { compileSafeRegexDetailed } from "../../security/safe-regex.js";
import { isCronJobActive } from "../active-jobs.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { parseCronPacingBounds } from "../pacing.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import {
  coerceFiniteScheduleNumber,
  computeNextRunAtMs,
  computePreviousRunAtMs,
} from "../schedule.js";
import {
  createTrustedCronScheduledToolPolicy,
  resolveCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
} from "../scheduled-tool-policy.js";
import { normalizeCronScriptPayload } from "../script-payload.js";
import { assertSafeCronSessionTargetId } from "../session-target.js";
import {
  normalizeCronStaggerMs,
  resolveCronStaggerMs,
  resolveDefaultCronStaggerMs,
} from "../stagger.js";
import { createCronStreamSourceIdentity, resolveCronStreamBatching } from "../stream-schedule.js";
import { applyDefaultCronToolsAllow, cronJobUsesToolRuntime } from "../tools-allow.js";
import type {
  CronDelivery,
  CronDeliveryPatch,
  CronFailureAlert,
  CronFailureAlertPatch,
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronSchedule,
} from "../types.js";
import { normalizeHttpWebhookUrl } from "../webhook-url.js";
import { resolveInitialCronDelivery } from "./initial-delivery.js";
import {
  normalizeOptionalAgentId,
  normalizePayloadToSystemText,
  normalizeRequiredName,
} from "./normalize.js";
import { mergeCronPayload } from "./payload-merge.js";
import { isQueuedCronRun, isQueuedForceCronRun } from "./run-admission.js";
import type { CronServiceState } from "./state.js";

const STUCK_RUN_MS = 2 * 60 * 60 * 1000;
const STAGGER_OFFSET_CACHE_MAX = 4096;
const CRON_DECLARATIVE_LABEL_MAX_LENGTH = 200;
const staggerOffsetCache = new Map<string, number>();

function normalizeStreamScheduleBounds(schedule: CronSchedule): CronSchedule {
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
  // Manual (force/due) errors are recorded but must not open a backoff window:
  // doing so would delay the next timer-scheduled fire of a recurring job.
  if (job.state.lastRunWasManual === true) {
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

function resolveEveryAnchorMs(params: {
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

/** Validates that session target and payload kind form a supported cron job shape. */
export function assertSupportedJobSpec(
  job: Pick<CronJob, "schedule" | "sessionTarget" | "payload">,
) {
  if (typeof job.sessionTarget !== "string") {
    throw new Error(
      'cron job is missing sessionTarget; expected "main", "isolated", "current", or "session:<id>"',
    );
  }
  const isIsolatedLike =
    job.sessionTarget === "isolated" ||
    job.sessionTarget === "current" ||
    job.sessionTarget.startsWith("session:");
  if (job.sessionTarget.startsWith("session:")) {
    assertSafeCronSessionTargetId(job.sessionTarget.slice(8));
  }
  if (
    job.sessionTarget === "main" &&
    job.payload.kind !== "systemEvent" &&
    job.payload.kind !== "script" &&
    job.payload.kind !== "heartbeat"
  ) {
    throw new Error('main cron jobs require payload.kind="systemEvent" or "script"');
  }
  if (
    job.payload.kind === "script" &&
    job.sessionTarget !== "main" &&
    job.sessionTarget !== "isolated"
  ) {
    throw new Error('script cron jobs require sessionTarget="main" or "isolated"');
  }
  if (
    isIsolatedLike &&
    job.payload.kind !== "agentTurn" &&
    job.payload.kind !== "command" &&
    !(job.sessionTarget === "isolated" && job.payload.kind === "script")
  ) {
    throw new Error(
      'isolated cron jobs require payload.kind="agentTurn", "command", or "script"; script payloads do not support current/session targets',
    );
  }
}

function assertScriptPayloadSupport(
  job: Pick<CronJob, "payload" | "trigger">,
  opts?: { cronConfig?: CronConfig; requireEnabled?: boolean },
) {
  if (job.payload.kind !== "script") {
    return;
  }
  if (!job.payload.script.trim()) {
    throw new Error("cron script payload must not be empty");
  }
  if (job.trigger) {
    // Both script kinds expose trigger.state, so composing them would give one
    // persisted state slot two owners and make the next trigger run ambiguous.
    throw new Error("cron script payloads cannot be combined with a condition trigger");
  }
  if (opts?.requireEnabled && opts.cronConfig?.triggers?.enabled !== true) {
    throw new Error(
      "cron script payloads are disabled; set cron.triggers.enabled=true to allow unattended scripts",
    );
  }
}

function assertTriggerSupport(
  job: Pick<CronJob, "schedule" | "trigger">,
  opts?: { cronConfig?: CronConfig; requireEnabled?: boolean },
) {
  if (!job.trigger) {
    return;
  }
  if (opts?.requireEnabled && opts.cronConfig?.triggers?.enabled !== true) {
    throw new Error("cron triggers are disabled; set cron.triggers.enabled=true");
  }
  if (
    job.schedule.kind !== "every" &&
    job.schedule.kind !== "cron" &&
    job.schedule.kind !== "stream"
  ) {
    throw new Error("cron triggers require an every, cron, or stream schedule");
  }
  const minIntervalMs = resolveCronTriggerMinIntervalMs();
  if (job.schedule.kind === "every" && job.schedule.everyMs < minIntervalMs) {
    throw new Error(`cron trigger every interval must be at least ${minIntervalMs}ms`);
  }
}

function assertPacingSupport(job: Pick<CronJob, "schedule" | "pacing">) {
  if (job.pacing === undefined) {
    return;
  }
  parseCronPacingBounds(job.pacing);
  if (job.schedule.kind !== "every" && job.schedule.kind !== "cron") {
    throw new Error("cron pacing requires an every or cron schedule");
  }
}

function assertStreamScheduleSupport(
  job: Pick<CronJob, "schedule" | "payload">,
  opts?: { cronConfig?: CronConfig; requireEnabled?: boolean },
) {
  if (job.schedule.kind !== "stream") {
    return;
  }
  if (opts?.requireEnabled && opts.cronConfig?.triggers?.enabled !== true) {
    throw new Error("cron stream schedules are disabled; set cron.triggers.enabled=true");
  }
  const { command, mode = "line", match } = job.schedule;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error("cron stream schedule requires a non-empty command argv array");
  }
  if (mode !== "line" && mode !== "match") {
    throw new Error('cron stream mode must be "line" or "match"');
  }
  if (mode === "match") {
    if (typeof match !== "string" || !match) {
      throw new Error('cron stream match is required when mode="match"');
    }
    const compiled = compileSafeRegexDetailed(match);
    if (!compiled.regex) {
      throw new Error(`cron stream match is not a safe regular expression (${compiled.reason})`);
    }
  } else if (match !== undefined) {
    throw new Error('cron stream match requires mode="match"');
  }
  if (job.payload.kind === "command") {
    throw new Error("cron stream schedules cannot use command payloads");
  }
}

function assertCronExpressionSatisfiable(job: CronJob, nowMs: number) {
  if (job.schedule.kind !== "cron") {
    return;
  }
  if (computeJobNextRunAtMs({ ...job, enabled: true }, nowMs) !== undefined) {
    return;
  }
  throw new Error(
    `cron expression "${job.schedule.expr}" has no upcoming run time and would never fire`,
  );
}

function assertMainSessionAgentId(
  job: Pick<CronJob, "sessionTarget" | "agentId" | "payload">,
  defaultAgentId: string | undefined,
) {
  if (job.sessionTarget !== "main") {
    return;
  }
  if (!job.agentId) {
    return;
  }
  // Script payloads run no agent turn; heartbeat monitors only poke the wake
  // bus and the heartbeat runner resolves the owning agent's main session
  // itself, so both are valid for non-default agents.
  if (job.payload.kind === "script" || job.payload.kind === "heartbeat") {
    return;
  }
  const normalized = normalizeAgentId(job.agentId);
  const normalizedDefault = normalizeAgentId(defaultAgentId);
  if (normalized !== normalizedDefault) {
    throw new Error(
      `cron: sessionTarget "main" is only valid for the default agent. Use sessionTarget "isolated" with payload.kind "agentTurn" for non-default agents (agentId: ${job.agentId})`,
    );
  }
}

function assertDeliverySupport(job: Pick<CronJob, "sessionTarget" | "delivery">) {
  if (!job.delivery) {
    return;
  }
  // No primary delivery and no completion webhook -- nothing to validate.
  if (job.delivery.mode === "none" && !job.delivery.completionDestination) {
    return;
  }
  // Webhook delivery is allowed for any session target
  if (job.delivery.mode === "webhook") {
    const target = normalizeHttpWebhookUrl(job.delivery.to);
    if (!target) {
      throw new Error("cron webhook delivery requires delivery.to to be a valid http(s) URL");
    }
    job.delivery.to = target;
  }
  if (job.delivery.completionDestination?.mode === "webhook") {
    if (job.delivery.mode !== "announce") {
      throw new Error(
        'cron completion destination webhook is only supported with delivery.mode="announce"',
      );
    }
    const target = normalizeHttpWebhookUrl(job.delivery.completionDestination.to);
    if (!target) {
      throw new Error(
        "cron completion destination webhook requires delivery.completionDestination.to to be a valid http(s) URL",
      );
    }
    job.delivery.completionDestination.to = target;
  }
  if (job.delivery.mode === "none") {
    return;
  }
  if (job.delivery.mode === "webhook") {
    // Webhook delivery is standalone and does not need an isolated chat target.
    return;
  }
  const isIsolatedLike =
    job.sessionTarget === "isolated" ||
    job.sessionTarget === "current" ||
    job.sessionTarget.startsWith("session:");
  if (!isIsolatedLike) {
    throw new Error('cron channel delivery config is only supported for sessionTarget="isolated"');
  }
}

function hasConcreteFailureDestination(
  destination: CronDelivery["failureDestination"] | undefined,
): boolean {
  return Boolean(
    destination &&
    (destination.channel !== undefined ||
      destination.to !== undefined ||
      destination.accountId !== undefined ||
      destination.mode !== undefined),
  );
}

function assertFailureDestinationSupport(job: Pick<CronJob, "sessionTarget" | "delivery">) {
  const failureDestination = job.delivery?.failureDestination;
  if (!failureDestination) {
    return;
  }
  if (!hasConcreteFailureDestination(failureDestination)) {
    return;
  }
  if (job.sessionTarget === "main" && job.delivery?.mode !== "webhook") {
    throw new Error(
      'cron delivery.failureDestination is only supported for sessionTarget="isolated" unless delivery.mode="webhook"',
    );
  }
  if (failureDestination.mode === "webhook") {
    const target = normalizeHttpWebhookUrl(failureDestination.to);
    if (!target) {
      throw new Error(
        "cron failure destination webhook requires delivery.failureDestination.to to be a valid http(s) URL",
      );
    }
    failureDestination.to = target;
  }
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
    nowMs - queuedAt > STUCK_RUN_MS &&
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
    nowMs - runningAt > STUCK_RUN_MS &&
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
function stampScheduledToolPolicy(
  job: CronJob,
  scheduledToolPolicy: CronScheduledToolPolicy | undefined,
): void {
  if (!cronJobUsesToolRuntime(job) || job.payload.toolsAllow === undefined) {
    delete job.scheduledToolPolicy;
    return;
  }
  const policy = scheduledToolPolicy ?? createTrustedCronScheduledToolPolicy();
  if (
    policy.mode === "account" &&
    (job.owner?.sessionKey !== policy.ownerSessionKey ||
      job.owner?.accountId !== policy.ownerAccountId)
  ) {
    throw new Error("scheduled account policy must match the persisted job owner");
  }
  job.scheduledToolPolicy = structuredClone(policy);
}

function reconcileScheduledToolPolicy(params: {
  job: CronJob;
  previouslyUsedToolRuntime: boolean;
  explicitlyMutatesToolsAllow: boolean;
  scheduledToolPolicy?: CronScheduledToolPolicy;
}): void {
  const { job } = params;
  if (!cronJobUsesToolRuntime(job) || job.payload.toolsAllow === undefined) {
    delete job.scheduledToolPolicy;
    return;
  }
  const current = resolveCronScheduledToolPolicy({
    toolsAllow: job.payload.toolsAllow,
    scheduledToolPolicy: job.scheduledToolPolicy,
    owner: job.owner,
  });
  if (current) {
    job.scheduledToolPolicy = current;
    return;
  }
  delete job.scheduledToolPolicy;
  if (params.explicitlyMutatesToolsAllow || !params.previouslyUsedToolRuntime) {
    stampScheduledToolPolicy(job, params.scheduledToolPolicy);
  }
}

/** Creates a normalized cron job row from public add input and computes its initial schedule. */
export function createJob(
  state: CronServiceState,
  input: CronJobCreate,
  opts?: { scheduledToolPolicy?: CronScheduledToolPolicy },
): CronJob {
  const now = state.deps.nowMs();
  const id = normalizeOptionalString(input.id) ?? crypto.randomUUID();
  const schedule =
    input.schedule.kind === "every"
      ? {
          ...input.schedule,
          anchorMs: resolveEveryAnchorMs({
            schedule: input.schedule,
            fallbackAnchorMs: now,
          }),
        }
      : input.schedule.kind === "cron"
        ? (() => {
            const explicitStaggerMs = normalizeCronStaggerMs(input.schedule.staggerMs);
            if (explicitStaggerMs !== undefined) {
              return { ...input.schedule, staggerMs: explicitStaggerMs };
            }
            const defaultStaggerMs = resolveDefaultCronStaggerMs(input.schedule.expr);
            return defaultStaggerMs !== undefined
              ? { ...input.schedule, staggerMs: defaultStaggerMs }
              : input.schedule;
          })()
        : normalizeStreamScheduleBounds(input.schedule);
  const deleteAfterRun =
    typeof input.deleteAfterRun === "boolean"
      ? input.deleteAfterRun
      : schedule.kind === "at"
        ? true
        : undefined;
  const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
  const declarationKey = normalizeOptionalString(input.declarationKey);
  if (input.declarationKey !== undefined && !declarationKey) {
    throw new Error("cron declarationKey must not be blank");
  }
  if (declarationKey && declarationKey.length > CRON_DECLARATIVE_LABEL_MAX_LENGTH) {
    throw new Error(
      `cron declarationKey must be at most ${CRON_DECLARATIVE_LABEL_MAX_LENGTH} characters`,
    );
  }
  const displayName = normalizeOptionalString(input.displayName);
  if (input.displayName !== undefined && !displayName) {
    throw new Error("cron displayName must not be blank");
  }
  if (displayName && displayName.length > CRON_DECLARATIVE_LABEL_MAX_LENGTH) {
    throw new Error(
      `cron displayName must be at most ${CRON_DECLARATIVE_LABEL_MAX_LENGTH} characters`,
    );
  }
  const ownerAgentId = normalizeOptionalAgentId(input.owner?.agentId);
  const ownerSessionKey = normalizeOptionalString(input.owner?.sessionKey);
  const ownerAccountId = normalizeOptionalAccountId(input.owner?.accountId);
  const job: CronJob = {
    id,
    ...(declarationKey ? { declarationKey } : {}),
    ...(displayName ? { displayName } : {}),
    ...(ownerAgentId || ownerSessionKey || ownerAccountId
      ? {
          owner: {
            ...(ownerAgentId ? { agentId: ownerAgentId } : {}),
            ...(ownerSessionKey ? { sessionKey: ownerSessionKey } : {}),
            ...(ownerAccountId ? { accountId: ownerAccountId } : {}),
          },
        }
      : {}),
    agentId: normalizeOptionalAgentId(input.agentId),
    sessionKey: normalizeOptionalString((input as { sessionKey?: unknown }).sessionKey),
    name: normalizeRequiredName(input.name),
    description: normalizeOptionalString(input.description),
    enabled,
    deleteAfterRun,
    createdAtMs: now,
    updatedAtMs: now,
    schedule,
    ...(input.pacing !== undefined ? { pacing: structuredClone(input.pacing) } : {}),
    sessionTarget: input.sessionTarget,
    wakeMode: input.wakeMode,
    payload:
      input.payload.kind === "script"
        ? normalizeCronScriptPayload(structuredClone(input.payload))
        : structuredClone(input.payload),
    delivery: resolveInitialCronDelivery(input),
    failureAlert: input.failureAlert,
    ...(input.trigger ? { trigger: structuredClone(input.trigger) } : {}),
    state: {
      ...input.state,
      ...(schedule.kind === "stream"
        ? { streamSourceIdentity: createCronStreamSourceIdentity() }
        : {}),
    },
  };
  // New trusted jobs are explicit by construction. Agent-runtime callers are
  // required to arrive with a creator cap before the service can apply this default.
  applyDefaultCronToolsAllow(job);
  stampScheduledToolPolicy(job, opts?.scheduledToolPolicy);
  assertSupportedJobSpec(job);
  assertPacingSupport(job);
  assertTriggerSupport(job, {
    cronConfig: state.deps.cronConfig,
    requireEnabled: job.trigger !== undefined,
  });
  assertScriptPayloadSupport(job, {
    cronConfig: state.deps.cronConfig,
    requireEnabled: job.payload.kind === "script",
  });
  assertStreamScheduleSupport(job, {
    cronConfig: state.deps.cronConfig,
    requireEnabled: true,
  });
  assertMainSessionAgentId(job, state.deps.defaultAgentId);
  assertDeliverySupport(job);
  assertFailureDestinationSupport(job);
  assertCronExpressionSatisfiable(job, now);
  job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
  return job;
}

/** Applies a public cron patch in-place, preserving omitted nested fields and validating the result. */
export function applyJobPatch(
  job: CronJob,
  patch: CronJobPatch,
  opts?: {
    defaultAgentId?: string;
    scheduleValidationNowMs?: number;
    cronConfig?: CronConfig;
    scheduledToolPolicy?: CronScheduledToolPolicy;
  },
) {
  const previouslyUsedToolRuntime = cronJobUsesToolRuntime(job);
  const explicitlyClearsToolsAllow = patch.payload?.toolsAllow === null;
  const previousScheduleKind = job.schedule.kind;
  if ("name" in patch) {
    job.name = normalizeRequiredName(patch.name);
  }
  if ("description" in patch) {
    job.description = normalizeOptionalString(patch.description);
  }
  if ("displayName" in patch) {
    const displayName = normalizeOptionalString(patch.displayName);
    if (patch.displayName !== null && patch.displayName !== undefined && !displayName) {
      throw new Error("cron displayName must not be blank");
    }
    if (displayName && displayName.length > CRON_DECLARATIVE_LABEL_MAX_LENGTH) {
      throw new Error(
        `cron displayName must be at most ${CRON_DECLARATIVE_LABEL_MAX_LENGTH} characters`,
      );
    }
    if (displayName) {
      job.displayName = displayName;
    } else {
      delete job.displayName;
    }
  }
  if (typeof patch.enabled === "boolean") {
    job.enabled = patch.enabled;
  }
  const hasDeleteAfterRunPatch = typeof patch.deleteAfterRun === "boolean";
  if (hasDeleteAfterRunPatch) {
    job.deleteAfterRun = patch.deleteAfterRun;
  } else if (
    patch.schedule?.kind === "at" &&
    (previousScheduleKind === "every" || previousScheduleKind === "cron")
  ) {
    // A schedule-kind transition starts a new retention contract. Do not let a
    // recurring job's ignored/stale flag defeat the one-shot cleanup default.
    job.deleteAfterRun = true;
  } else if (
    previousScheduleKind === "at" &&
    (patch.schedule?.kind === "every" || patch.schedule?.kind === "cron")
  ) {
    delete job.deleteAfterRun;
  }
  if (patch.schedule) {
    if (patch.schedule.kind === "cron") {
      const explicitStaggerMs = normalizeCronStaggerMs(patch.schedule.staggerMs);
      if (explicitStaggerMs !== undefined) {
        job.schedule = { ...patch.schedule, staggerMs: explicitStaggerMs };
      } else if (job.schedule.kind === "cron") {
        // Preserve an existing explicit stagger when editing only the cron
        // expression; otherwise a patch could silently change fire timing.
        job.schedule = { ...patch.schedule, staggerMs: job.schedule.staggerMs };
      } else {
        const defaultStaggerMs = resolveDefaultCronStaggerMs(patch.schedule.expr);
        job.schedule =
          defaultStaggerMs !== undefined
            ? { ...patch.schedule, staggerMs: defaultStaggerMs }
            : patch.schedule;
      }
    } else {
      job.schedule = normalizeStreamScheduleBounds(patch.schedule);
    }
  }
  if ("trigger" in patch) {
    if (patch.trigger === null || patch.trigger === undefined) {
      delete job.trigger;
    } else {
      job.trigger = structuredClone(patch.trigger);
    }
  }
  if ("pacing" in patch) {
    if (patch.pacing === null || patch.pacing === undefined) {
      delete job.pacing;
    } else {
      job.pacing = structuredClone(patch.pacing);
    }
  }
  if (patch.sessionTarget) {
    job.sessionTarget = patch.sessionTarget;
  }
  if (patch.wakeMode) {
    job.wakeMode = patch.wakeMode;
  }
  if (patch.payload) {
    job.payload = mergeCronPayload(job.payload, patch.payload);
    if (job.payload.kind === "script") {
      job.payload = normalizeCronScriptPayload(job.payload);
    }
  }
  if (cronJobUsesToolRuntime(job) && (!previouslyUsedToolRuntime || explicitlyClearsToolsAllow)) {
    // `null` means unrestricted, not a return to ambiguous legacy semantics.
    // Ordinary edits to an existing capless job intentionally remain legacy.
    applyDefaultCronToolsAllow(job);
  }
  reconcileScheduledToolPolicy({
    job,
    previouslyUsedToolRuntime,
    explicitlyMutatesToolsAllow:
      patch.payload !== undefined && Object.hasOwn(patch.payload, "toolsAllow"),
    scheduledToolPolicy: opts?.scheduledToolPolicy,
  });
  if (patch.delivery) {
    const implicitMode = resolveCronDeliveryPlan(job).mode;
    job.delivery = mergeCronDelivery(job.delivery, patch.delivery, implicitMode);
  }
  if ("failureAlert" in patch) {
    job.failureAlert = mergeCronFailureAlert(job.failureAlert, patch.failureAlert);
  }
  if (
    job.sessionTarget === "main" &&
    job.delivery?.mode !== "webhook" &&
    hasConcreteFailureDestination(job.delivery?.failureDestination)
  ) {
    throw new Error(
      'cron delivery.failureDestination is only supported for sessionTarget="isolated" unless delivery.mode="webhook"',
    );
  }
  if (job.sessionTarget === "main" && job.delivery?.mode !== "webhook") {
    // Main-session jobs cannot auto-announce; keep only an empty failure
    // destination object when the patch is clearing nested fields.
    const failureDestination = job.delivery?.failureDestination;
    job.delivery =
      failureDestination && !hasConcreteFailureDestination(failureDestination)
        ? { mode: "none", failureDestination }
        : undefined;
  }
  if (patch.state) {
    job.state = { ...job.state, ...patch.state };
  }
  if ("agentId" in patch) {
    job.agentId = normalizeOptionalAgentId((patch as { agentId?: unknown }).agentId);
  }
  if ("sessionKey" in patch) {
    job.sessionKey = normalizeOptionalString((patch as { sessionKey?: unknown }).sessionKey);
  }
  if (job.schedule.kind === "stream" && patch.enabled === true) {
    job.state.streamRestartExhausted = undefined;
    job.state.streamConsecutiveFailures = 0;
    job.state.streamError = undefined;
  }
  if (previousScheduleKind === "stream" && job.schedule.kind !== "stream") {
    job.state.streamStatus = undefined;
    job.state.streamError = undefined;
    job.state.streamConsecutiveFailures = undefined;
    job.state.streamRestartExhausted = undefined;
    job.state.streamSourceIdentity = undefined;
    job.state.streamDroppedBatches = undefined;
    job.state.streamCoalescedBatches = undefined;
    job.state.streamLastStartedAtMs = undefined;
    job.state.streamLastExitAtMs = undefined;
  }
  assertSupportedJobSpec(job);
  assertPacingSupport(job);
  assertTriggerSupport(job, {
    cronConfig: opts?.cronConfig,
    requireEnabled: patch.trigger !== null && patch.trigger !== undefined,
  });
  assertScriptPayloadSupport(job, {
    cronConfig: opts?.cronConfig,
    requireEnabled: patch.payload?.kind === "script",
  });
  assertStreamScheduleSupport(job, {
    cronConfig: opts?.cronConfig,
    requireEnabled: patch.enabled === true || patch.schedule?.kind === "stream",
  });
  assertMainSessionAgentId(job, opts?.defaultAgentId);
  assertDeliverySupport(job);
  assertFailureDestinationSupport(job);
  if (
    opts?.scheduleValidationNowMs !== undefined &&
    (patch.schedule !== undefined || patch.enabled === true)
  ) {
    assertCronExpressionSatisfiable(job, opts.scheduleValidationNowMs);
  }
}

/** Converges the declared schedule, payload, delivery, and display label only. */
export function applyDeclarativeJobSpec(
  job: CronJob,
  input: CronJobCreate,
  opts: {
    defaultAgentId?: string;
    enabledExplicit: boolean;
    nowMs: number;
    cronConfig?: CronConfig;
    scheduledToolPolicy?: CronScheduledToolPolicy;
  },
) {
  const previouslyUsedToolRuntime = cronJobUsesToolRuntime(job);
  const explicitlyDeclaresToolsAllow = input.payload.toolsAllow !== undefined;
  const previousToolsAllow = job.payload.toolsAllow;
  const previousToolsAllowIsDefault = job.payload.toolsAllowIsDefault;
  // Name, target, routing, owner, and run policy remain outside declaration
  // convergence; changing those uses cron.update and cannot retarget an identity.
  const displayName = normalizeOptionalString(input.displayName);
  if (input.displayName !== undefined && !displayName) {
    throw new Error("cron displayName must not be blank");
  }
  if (displayName && displayName.length > CRON_DECLARATIVE_LABEL_MAX_LENGTH) {
    throw new Error(
      `cron displayName must be at most ${CRON_DECLARATIVE_LABEL_MAX_LENGTH} characters`,
    );
  }
  if (displayName) {
    job.displayName = displayName;
  } else {
    delete job.displayName;
  }

  if (
    input.schedule.kind === "every" &&
    input.schedule.anchorMs === undefined &&
    job.schedule.kind === "every" &&
    job.schedule.everyMs === input.schedule.everyMs
  ) {
    job.schedule = { ...input.schedule, anchorMs: job.schedule.anchorMs };
  } else if (input.schedule.kind === "every" && input.schedule.anchorMs === undefined) {
    job.schedule = { ...input.schedule, anchorMs: opts.nowMs };
  } else if (input.schedule.kind === "cron") {
    const explicitStaggerMs = normalizeCronStaggerMs(input.schedule.staggerMs);
    const defaultStaggerMs = resolveDefaultCronStaggerMs(input.schedule.expr);
    job.schedule = {
      ...input.schedule,
      ...(explicitStaggerMs !== undefined
        ? { staggerMs: explicitStaggerMs }
        : defaultStaggerMs !== undefined
          ? { staggerMs: defaultStaggerMs }
          : {}),
    };
  } else {
    job.schedule = normalizeStreamScheduleBounds(structuredClone(input.schedule));
  }
  if (input.pacing !== undefined) {
    job.pacing = structuredClone(input.pacing);
  } else {
    delete job.pacing;
  }
  job.payload =
    input.payload.kind === "script"
      ? normalizeCronScriptPayload(structuredClone(input.payload))
      : structuredClone(input.payload);
  if (input.trigger) {
    job.trigger = structuredClone(input.trigger);
  } else {
    delete job.trigger;
  }
  if (cronJobUsesToolRuntime(job) && job.payload.toolsAllow === undefined) {
    if (previousToolsAllow !== undefined) {
      // Omitted declaration fields preserve explicit authority already stored
      // on the job, including the server-managed creator-default marker.
      job.payload.toolsAllow = [...previousToolsAllow];
      if (previousToolsAllowIsDefault === true) {
        job.payload.toolsAllowIsDefault = true;
      }
    } else if (!previouslyUsedToolRuntime) {
      // A declaration that newly becomes tool-bearing adopts current explicit semantics.
      applyDefaultCronToolsAllow(job);
    }
  }
  reconcileScheduledToolPolicy({
    job,
    previouslyUsedToolRuntime,
    explicitlyMutatesToolsAllow: explicitlyDeclaresToolsAllow,
    scheduledToolPolicy: opts.scheduledToolPolicy,
  });
  const delivery = resolveInitialCronDelivery(input);
  if (delivery) {
    job.delivery = structuredClone(delivery);
  } else {
    delete job.delivery;
  }
  if (opts.enabledExplicit) {
    job.enabled = input.enabled;
  }
  assertTriggerSupport(job, {
    cronConfig: opts.cronConfig,
    requireEnabled: input.trigger !== undefined,
  });
  assertScriptPayloadSupport(job, {
    cronConfig: opts.cronConfig,
    requireEnabled: input.payload.kind === "script",
  });
  assertStreamScheduleSupport(job, {
    cronConfig: opts.cronConfig,
    requireEnabled: true,
  });

  assertSupportedJobSpec(job);
  assertPacingSupport(job);
  assertMainSessionAgentId(job, opts.defaultAgentId);
  assertDeliverySupport(job);
  assertFailureDestinationSupport(job);
  assertCronExpressionSatisfiable(job, opts.nowMs);
}

function mergeCronDelivery(
  existing: CronDelivery | undefined,
  patch: CronDeliveryPatch,
  implicitMode: CronDelivery["mode"],
): CronDelivery | undefined {
  const hasCompletionDestinationPatch = "completionDestination" in patch;
  const next: CronDelivery = {
    mode: existing?.mode ?? implicitMode,
    channel: existing?.channel,
    to: existing?.to,
    threadId: existing?.threadId,
    accountId: existing?.accountId,
    bestEffort: existing?.bestEffort,
    completionDestination: existing?.completionDestination,
    failureDestination: existing?.failureDestination,
  };

  if (typeof patch.mode === "string") {
    const previousMode = next.mode;
    next.mode = (patch.mode as string) === "deliver" ? "announce" : patch.mode;
    if (previousMode !== next.mode && (previousMode === "webhook" || next.mode === "webhook")) {
      // `to` has different meaning for channel targets and webhook URLs; clear
      // it when crossing that boundary so stale destinations do not leak.
      next.to = undefined;
    }
    if (next.mode === "webhook") {
      next.channel = undefined;
      next.threadId = undefined;
      next.accountId = undefined;
    }
    if (!hasCompletionDestinationPatch && (next.mode === "none" || next.mode === "webhook")) {
      next.completionDestination = undefined;
    }
  }
  if ("channel" in patch) {
    next.channel = normalizeOptionalString(patch.channel);
  }
  if ("to" in patch) {
    next.to = normalizeOptionalString(patch.to);
  }
  if ("threadId" in patch) {
    next.threadId = normalizeOptionalThreadValue(patch.threadId);
  }
  if ("accountId" in patch) {
    next.accountId = normalizeOptionalString(patch.accountId);
  }
  if (typeof patch.bestEffort === "boolean") {
    next.bestEffort = patch.bestEffort;
  }
  if (hasCompletionDestinationPatch) {
    if (patch.completionDestination == null) {
      next.completionDestination = undefined;
    } else {
      const to = normalizeOptionalString(patch.completionDestination.to);
      next.completionDestination = {
        mode: "webhook",
        ...(to ? { to } : {}),
      };
    }
  }
  if ("failureDestination" in patch) {
    if (patch.failureDestination == null) {
      next.failureDestination = undefined;
    } else {
      const existingFd = next.failureDestination;
      const patchFd = patch.failureDestination;
      const nextFd: typeof next.failureDestination = {};
      if (existingFd) {
        if (Object.hasOwn(existingFd, "channel")) {
          nextFd.channel = existingFd.channel;
        }
        if (Object.hasOwn(existingFd, "to")) {
          nextFd.to = existingFd.to;
        }
        if (Object.hasOwn(existingFd, "accountId")) {
          nextFd.accountId = existingFd.accountId;
        }
        if (Object.hasOwn(existingFd, "mode")) {
          nextFd.mode = existingFd.mode;
        }
      }
      if (patchFd) {
        if ("channel" in patchFd) {
          const channel = normalizeOptionalString(patchFd.channel) ?? "";
          nextFd.channel = channel ? channel : undefined;
        }
        if ("to" in patchFd) {
          const to = normalizeOptionalString(patchFd.to) ?? "";
          nextFd.to = to ? to : undefined;
        }
        if ("accountId" in patchFd) {
          const accountId = normalizeOptionalString(patchFd.accountId) ?? "";
          nextFd.accountId = accountId ? accountId : undefined;
        }
        if ("mode" in patchFd) {
          const mode = normalizeOptionalString(patchFd.mode) ?? "";
          nextFd.mode = mode === "announce" || mode === "webhook" ? mode : undefined;
        }
      }
      const hasFailureDestination =
        Object.hasOwn(nextFd, "channel") ||
        Object.hasOwn(nextFd, "to") ||
        Object.hasOwn(nextFd, "accountId") ||
        Object.hasOwn(nextFd, "mode");
      next.failureDestination = hasFailureDestination ? nextFd : undefined;
    }
  }

  if (
    existing === undefined &&
    !("mode" in patch) &&
    next.channel === undefined &&
    next.to === undefined &&
    next.threadId === undefined &&
    next.accountId === undefined &&
    next.bestEffort === undefined &&
    next.completionDestination === undefined &&
    next.failureDestination === undefined
  ) {
    // Clearing an absent override must preserve implicit detached-job delivery.
    return undefined;
  }

  return next;
}

function mergeCronFailureAlert(
  existing: CronFailureAlert | false | undefined,
  patch: CronFailureAlertPatch | false | null | undefined,
): CronFailureAlert | false | undefined {
  if (patch === false) {
    return false;
  }
  if (patch === null) {
    return undefined;
  }
  if (patch === undefined) {
    return existing;
  }
  const base = existing === false || existing === undefined ? {} : existing;
  const next: CronFailureAlert = { ...base };

  if ("after" in patch) {
    const after = typeof patch.after === "number" && Number.isFinite(patch.after) ? patch.after : 0;
    next.after = after > 0 ? Math.floor(after) : undefined;
  }
  if ("channel" in patch) {
    next.channel = normalizeOptionalString(patch.channel);
  }
  if ("to" in patch) {
    next.to = normalizeOptionalString(patch.to);
  }
  if ("cooldownMs" in patch) {
    const cooldownMs =
      typeof patch.cooldownMs === "number" && Number.isFinite(patch.cooldownMs)
        ? patch.cooldownMs
        : -1;
    next.cooldownMs = cooldownMs >= 0 ? Math.floor(cooldownMs) : undefined;
  }
  if ("includeSkipped" in patch) {
    next.includeSkipped =
      typeof patch.includeSkipped === "boolean" ? patch.includeSkipped : undefined;
  }
  if ("mode" in patch) {
    const mode = normalizeOptionalString(patch.mode) ?? "";
    next.mode = mode === "announce" || mode === "webhook" ? mode : undefined;
  }
  if ("accountId" in patch) {
    const accountId = normalizeOptionalString(patch.accountId) ?? "";
    next.accountId = accountId ? accountId : undefined;
  }

  return next;
}

/**
 * Covers both durable reservations and the process marker that survives mutable job state.
 * Every timer/manual admission path must use this or disable/re-enable can duplicate a run.
 */
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
