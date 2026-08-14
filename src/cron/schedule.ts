/** Computes at/every/cron schedule timestamps with bounded Croner caching. */
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Cron, CronDate } from "croner";
import { parseOffsetlessIsoDateTimeInTimeZone } from "../infra/format-time/parse-offsetless-zoned-datetime.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { parseAbsoluteTimeMs } from "./parse.js";
import { coerceFiniteScheduleNumber } from "./schedule-number.js";
import type { CronSchedule } from "./types.js";

const CRON_EVAL_CACHE_MAX = 512;
const DAY_MS = 86_400_000;
const cronEvalCache = new Map<string, Cron>();
const cronTimezoneFormatters = new WeakMap<Cron, Intl.DateTimeFormat>();

function resolveCronTimezone(tz?: string) {
  const trimmed = normalizeOptionalString(tz) ?? "";
  if (trimmed) {
    return trimmed;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function resolveCachedCron(expr: string, timezone: string): Cron {
  const key = `${timezone}\u0000${expr}`;
  const cached = cronEvalCache.get(key);
  if (cached) {
    // Move to the end of Map iteration order so the bounded cache behaves as LRU.
    cronEvalCache.delete(key);
    cronEvalCache.set(key, cached);
    return cached;
  }
  // Expression parsing is expensive, so retain the most recently promoted entries.
  pruneMapToMaxSize(cronEvalCache, CRON_EVAL_CACHE_MAX - 1);
  const next = new Cron(expr, { timezone, catch: false });
  cronEvalCache.set(key, next);
  return next;
}

function resolveCronFromSchedule(schedule: { tz?: string; expr?: unknown }): Cron | undefined {
  if (typeof schedule.expr !== "string") {
    throw new Error("invalid cron schedule: expr is required");
  }
  const expr = schedule.expr.trim();
  if (!expr) {
    return undefined;
  }
  return resolveCachedCron(expr, resolveCronTimezone(schedule.tz));
}

function hasNearbyCronTimezoneTransition(
  cron: Cron,
  timezone: string,
  nowMs: number,
  candidateMs: number,
): boolean {
  let formatter = cronTimezoneFormatters.get(cron);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    });
    cronTimezoneFormatters.set(cron, formatter);
  }
  const resolvedFormatter = formatter;
  const readOffset = (instantMs: number) =>
    resolvedFormatter
      .formatToParts(new Date(instantMs))
      .find((part) => part.type === "timeZoneName")?.value;
  const currentOffset = readOffset(nowMs);
  const candidateOffset = readOffset(candidateMs);
  return (
    currentOffset !== candidateOffset ||
    currentOffset !== readOffset(nowMs - DAY_MS) ||
    candidateOffset !== readOffset(candidateMs - DAY_MS)
  );
}

function resolveCronWallTimeMs(instantMs: number, timezone: string): number {
  const local = new CronDate(new Date(instantMs), timezone);
  return Date.UTC(
    local.year,
    local.month,
    local.day,
    local.hour,
    local.minute,
    local.second,
    local.ms,
  );
}

function resolveFirstCronOccurrenceMs(instantMs: number, timezone: string): number | undefined {
  const wallTime = new Date(resolveCronWallTimeMs(instantMs, timezone)).toISOString().slice(0, -1);
  const resolved = parseOffsetlessIsoDateTimeInTimeZone(wallTime, timezone);
  return resolved === null ? undefined : Date.parse(resolved);
}

function matchesCronOccurrence(cron: Cron, instant: Date): boolean {
  const matchesOccurrence = cron.match.bind(cron);
  return matchesOccurrence(instant);
}

function findCronTimezoneTransitionMs(
  firstMs: number,
  lastMs: number,
  timezone: string,
): number | undefined {
  let beforeSeconds = Math.floor(Math.min(firstMs, lastMs) / 1_000);
  let afterSeconds = Math.floor(Math.max(firstMs, lastMs) / 1_000);
  const previousOffsetMs =
    resolveCronWallTimeMs(beforeSeconds * 1_000, timezone) - beforeSeconds * 1_000;
  const nextOffsetMs = resolveCronWallTimeMs(afterSeconds * 1_000, timezone) - afterSeconds * 1_000;
  if (previousOffsetMs === nextOffsetMs) {
    return undefined;
  }
  while (afterSeconds - beforeSeconds > 1) {
    const middleSeconds = Math.floor((beforeSeconds + afterSeconds) / 2);
    const middleOffsetMs =
      resolveCronWallTimeMs(middleSeconds * 1_000, timezone) - middleSeconds * 1_000;
    if (middleOffsetMs === previousOffsetMs) {
      beforeSeconds = middleSeconds;
    } else {
      afterSeconds = middleSeconds;
    }
  }
  return afterSeconds * 1_000;
}

function resolveCronRunAtTransitionMs(
  cron: Cron,
  transitionMs: number,
  timezone: string,
): number | undefined {
  let transition = new Date(transitionMs);
  // Croner's finite year horizon bounds this search; historical timezone
  // policies can make many consecutive annual occurrences nonexistent.
  for (;;) {
    const candidate = matchesCronOccurrence(cron, transition)
      ? transition
      : cron.nextRun(transition);
    if (!candidate) {
      return undefined;
    }
    if (matchesCronOccurrence(cron, candidate)) {
      return resolveFirstCronOccurrenceMs(candidate.getTime(), timezone);
    }
    const candidateMs = candidate.getTime();
    const nextTransitionMs = findCronTimezoneTransitionMs(
      candidateMs - DAY_MS,
      candidateMs,
      timezone,
    );
    if (nextTransitionMs === undefined || nextTransitionMs <= transition.getTime()) {
      return undefined;
    }
    transition = new Date(nextTransitionMs);
  }
}

function resolveNextCronOccurrenceMs(
  cron: Cron,
  nowMs: number,
  nextMs: number,
  timezone: string,
): number | undefined {
  if (!matchesCronOccurrence(cron, new Date(nextMs))) {
    // Croner invents an instant for a nonexistent local time; bracket the gap,
    // not the request, so annual schedules crossing several transitions work.
    const transitionMs = findCronTimezoneTransitionMs(nextMs - DAY_MS, nextMs, timezone);
    return transitionMs === undefined
      ? undefined
      : resolveCronRunAtTransitionMs(cron, transitionMs, timezone);
  }

  const firstOccurrenceMs = resolveFirstCronOccurrenceMs(nextMs, timezone);
  if (firstOccurrenceMs === undefined || firstOccurrenceMs > nowMs) {
    return firstOccurrenceMs;
  }

  const firstCurrentOccurrenceMs = resolveFirstCronOccurrenceMs(nowMs, timezone);
  const inRepeatedInterval =
    firstCurrentOccurrenceMs !== undefined && firstCurrentOccurrenceMs < nowMs;
  const transitionStartMs = inRepeatedInterval ? firstCurrentOccurrenceMs : nowMs;
  const transitionEndMs = inRepeatedInterval ? nowMs : nextMs;
  const overlapMs = inRepeatedInterval
    ? nowMs - firstCurrentOccurrenceMs
    : nextMs - firstOccurrenceMs;
  const transitionMs = findCronTimezoneTransitionMs(transitionStartMs, transitionEndMs, timezone);
  if (transitionMs === undefined) {
    return undefined;
  }

  // Croner folds only a fixed hour. Use the actual offset change so 30-minute
  // and two-hour repeated clocks run once, at their first occurrence.
  return resolveCronRunAtTransitionMs(cron, transitionMs + overlapMs, timezone);
}

function resolveValidatedNextCronOccurrenceMs(
  cron: Cron,
  nowMs: number,
  candidateMs: number,
  timezone: string,
): number | undefined {
  if (candidateMs > nowMs && !hasNearbyCronTimezoneTransition(cron, timezone, nowMs, candidateMs)) {
    return candidateMs;
  }
  const normalizedMs = resolveNextCronOccurrenceMs(cron, nowMs, candidateMs, timezone);
  return normalizedMs !== undefined && normalizedMs > nowMs ? normalizedMs : undefined;
}

/** Computes the next scheduled run timestamp after now for at/every/cron schedules. */
export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (asDateTimestampMs(nowMs) === undefined) {
    return undefined;
  }
  if (schedule.kind === "at") {
    const atMs = parseAbsoluteTimeMs(schedule.at);
    if (atMs === null) {
      return undefined;
    }
    return atMs > nowMs ? atMs : undefined;
  }

  if (schedule.kind === "every") {
    const everyMsRaw = coerceFiniteScheduleNumber(schedule.everyMs);
    if (everyMsRaw === undefined) {
      return undefined;
    }
    const everyMs = Math.floor(everyMsRaw);
    if (everyMs < 1) {
      return undefined;
    }
    const anchorRaw = coerceFiniteScheduleNumber(schedule.anchorMs);
    if (schedule.anchorMs !== undefined && (anchorRaw === undefined || anchorRaw < 0)) {
      return undefined;
    }
    const anchor = Math.max(0, Math.floor(anchorRaw ?? nowMs));
    if (nowMs < anchor) {
      return anchor;
    }
    const elapsed = nowMs - anchor;
    const steps = Math.floor(elapsed / everyMs) + 1;
    return asDateTimestampMs(anchor + steps * everyMs);
  }

  if (schedule.kind === "on-exit" || schedule.kind === "stream") {
    // Event-driven trigger: never time-due. The gateway watcher calls
    // enqueueRun when the watched command exits or a stream batch closes.
    return undefined;
  }

  const cron = resolveCronFromSchedule(schedule);
  if (!cron) {
    return undefined;
  }
  const nextMs = cron.nextRun(new Date(nowMs))?.getTime();
  if (nextMs === undefined) {
    return undefined;
  }

  const timezone = resolveCronTimezone(schedule.tz);
  const normalizedNextMs = resolveValidatedNextCronOccurrenceMs(cron, nowMs, nextMs, timezone);
  if (normalizedNextMs !== undefined) {
    return normalizedNextMs;
  }
  if (nextMs > nowMs) {
    return undefined;
  }

  // Workaround for croner year-rollback bug: some timezone/date combinations
  // (e.g. Asia/Shanghai) cause nextRun to return a timestamp in a past year.
  // Retry from a later reference point when the returned time is not in the
  // future.
  const nextSecondMs = Math.floor(nowMs / 1000) * 1000 + 1000;
  const retryMs = cron.nextRun(new Date(nextSecondMs))?.getTime();
  if (retryMs !== undefined) {
    const normalizedRetryMs = resolveValidatedNextCronOccurrenceMs(cron, nowMs, retryMs, timezone);
    if (normalizedRetryMs !== undefined) {
      return normalizedRetryMs;
    }
  }
  // Still in the past — try from start of tomorrow (UTC) as a broader reset.
  const tomorrowMs = new Date(nowMs).setUTCHours(24, 0, 0, 0);
  const retry2Ms = cron.nextRun(new Date(tomorrowMs))?.getTime();
  return retry2Ms !== undefined
    ? resolveValidatedNextCronOccurrenceMs(cron, nowMs, retry2Ms, timezone)
    : undefined;
}

/** Computes the previous cron-expression run timestamp before now. */
export function computePreviousRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind !== "cron" || asDateTimestampMs(nowMs) === undefined) {
    return undefined;
  }
  const cron = resolveCronFromSchedule(schedule);
  if (!cron) {
    return undefined;
  }
  let previousMs = cron.previousRuns(1, new Date(nowMs))[0]?.getTime();
  const timezone = resolveCronTimezone(schedule.tz);
  if (
    previousMs !== undefined &&
    previousMs < nowMs &&
    !hasNearbyCronTimezoneTransition(cron, timezone, nowMs, previousMs)
  ) {
    return previousMs;
  }

  const firstCurrentOccurrenceMs = resolveFirstCronOccurrenceMs(nowMs, timezone);
  if (firstCurrentOccurrenceMs !== undefined && firstCurrentOccurrenceMs < nowMs) {
    const transitionMs = findCronTimezoneTransitionMs(firstCurrentOccurrenceMs, nowMs, timezone);
    if (transitionMs !== undefined) {
      const overlapEndMs = transitionMs + nowMs - firstCurrentOccurrenceMs;
      const candidateMs = cron.previousRuns(1, new Date(overlapEndMs))[0]?.getTime();
      if (candidateMs !== undefined) {
        previousMs = candidateMs;
      }
    }
  }
  if (previousMs === undefined) {
    return undefined;
  }

  // previousRuns ends at Croner's minimum supported year; never drop valid
  // historical occurrences after an arbitrary number of changed DST rules.
  while (!matchesCronOccurrence(cron, new Date(previousMs))) {
    const transitionMs = findCronTimezoneTransitionMs(previousMs - DAY_MS, previousMs, timezone);
    if (transitionMs === undefined) {
      return undefined;
    }
    const beforeTransition = new Date(transitionMs - 1_000);
    const candidate = matchesCronOccurrence(cron, beforeTransition)
      ? beforeTransition
      : cron.previousRuns(1, beforeTransition)[0];
    const candidateMs = candidate?.getTime();
    if (candidateMs === undefined || candidateMs >= previousMs) {
      return undefined;
    }
    previousMs = candidateMs;
  }

  const normalizedPreviousMs = resolveFirstCronOccurrenceMs(previousMs, timezone);
  return normalizedPreviousMs !== undefined && normalizedPreviousMs < nowMs
    ? normalizedPreviousMs
    : undefined;
}

/** Clears the Croner expression cache for deterministic tests. */
function clearCronScheduleCacheForTest(): void {
  cronEvalCache.clear();
}

/** Returns the Croner expression cache size for tests. */
function getCronScheduleCacheSizeForTest(): number {
  return cronEvalCache.size;
}

/** Returns the Croner expression cache capacity for tests. */
function getCronScheduleCacheMaxForTest(): number {
  return CRON_EVAL_CACHE_MAX;
}

/** Returns whether an expression/timezone pair is present in the Croner cache for tests. */
function hasCronInCacheForTest(expr: string, tz: string): boolean {
  return cronEvalCache.has(`${tz}\u0000${expr}`);
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cronScheduleTestApi")] = {
    clearCronScheduleCacheForTest,
    getCronScheduleCacheSizeForTest,
    getCronScheduleCacheMaxForTest,
    hasCronInCacheForTest,
  };
}
