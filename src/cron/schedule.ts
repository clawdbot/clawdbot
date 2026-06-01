import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Cron } from "croner";
import { parseAbsoluteTimeMs } from "./parse.js";
import { coerceFiniteScheduleNumber } from "./schedule-number.js";
import type { CronSchedule } from "./types.js";

export { coerceFiniteScheduleNumber } from "./schedule-number.js";

const CRON_EVAL_CACHE_MAX = 512;
const cronEvalCache = new Map<string, Cron>();

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
  if (cronEvalCache.size >= CRON_EVAL_CACHE_MAX) {
    const oldest = cronEvalCache.keys().next().value;
    if (oldest) {
      cronEvalCache.delete(oldest);
    }
  }
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

/** Computes the next scheduled run timestamp after now for at/every/cron schedules. */
export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
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
    const everyMs = Math.max(1, Math.floor(everyMsRaw));
    const anchorRaw = coerceFiniteScheduleNumber(schedule.anchorMs);
    const anchor = Math.max(0, Math.floor(anchorRaw ?? nowMs));
    if (nowMs < anchor) {
      return anchor;
    }
    const elapsed = nowMs - anchor;
    const steps = Math.floor(elapsed / everyMs) + 1;
    return anchor + steps * everyMs;
  }

  const cron = resolveCronFromSchedule(schedule);
  if (!cron) {
    return undefined;
  }
  const next = cron.nextRun(new Date(nowMs));
  if (!next) {
    return undefined;
  }
  const nextMs = next.getTime();
  if (!Number.isFinite(nextMs)) {
    return undefined;
  }

  // Workaround for croner year-rollback bug: some timezone/date combinations
  // (e.g. Asia/Shanghai) cause nextRun to return a timestamp in a past year.
  // Retry from a later reference point when the returned time is not in the
  // future.
  if (nextMs <= nowMs) {
    const nextSecondMs = Math.floor(nowMs / 1000) * 1000 + 1000;
    const retry = cron.nextRun(new Date(nextSecondMs));
    if (retry) {
      const retryMs = retry.getTime();
      if (Number.isFinite(retryMs) && retryMs > nowMs) {
        return retryMs;
      }
    }
    // Still in the past — try from start of tomorrow (UTC) as a broader reset.
    const tomorrowMs = new Date(nowMs).setUTCHours(24, 0, 0, 0);
    const retry2 = cron.nextRun(new Date(tomorrowMs));
    if (retry2) {
      const retry2Ms = retry2.getTime();
      if (Number.isFinite(retry2Ms) && retry2Ms > nowMs) {
        return retry2Ms;
      }
    }
    return undefined;
  }

  return nextMs;
}

/** Computes the previous cron-expression run timestamp before now. */
export function computePreviousRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind !== "cron") {
    return undefined;
  }
  const cron = resolveCronFromSchedule(schedule);
  if (!cron) {
    return undefined;
  }
  const previousRuns = cron.previousRuns(1, new Date(nowMs));
  const previous = previousRuns[0];
  if (!previous) {
    return undefined;
  }
  const previousMs = previous.getTime();
  if (!Number.isFinite(previousMs)) {
    return undefined;
  }
  if (previousMs >= nowMs) {
    return undefined;
  }
  return previousMs;
}

/** Clears the Croner expression cache for deterministic tests. */
export function clearCronScheduleCacheForTest(): void {
  cronEvalCache.clear();
}

/** Returns the Croner expression cache size for tests. */
export function getCronScheduleCacheSizeForTest(): number {
  return cronEvalCache.size;
}

/** Returns the Croner expression cache capacity for tests. */
export function getCronScheduleCacheMaxForTest(): number {
  return CRON_EVAL_CACHE_MAX;
}

/** Returns whether an expression/timezone pair is present in the Croner cache for tests. */
export function hasCronInCacheForTest(expr: string, tz: string): boolean {
  return cronEvalCache.has(`${tz}\u0000${expr}`);
}
