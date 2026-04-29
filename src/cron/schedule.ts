import { Cron } from "croner";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { parseAbsoluteTimeMs } from "./parse.js";
import type { CronSchedule } from "./types.js";

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
    // Move to end of Map iteration order for LRU eviction
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

function resolveCronFromSchedule(schedule: {
  tz?: string;
  expr?: unknown;
  cron?: unknown;
}): Cron | undefined {
  const exprSource = typeof schedule.expr === "string" ? schedule.expr : schedule.cron;
  if (typeof exprSource !== "string") {
    throw new Error("invalid cron schedule: expr is required");
  }
  const expr = exprSource.trim();
  if (!expr) {
    return undefined;
  }
  return resolveCachedCron(expr, resolveCronTimezone(schedule.tz));
}

export function coerceFiniteScheduleNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind === "at") {
    // Handle both canonical `at` (string) and legacy `atMs` (number) fields.
    // The store migration should convert atMs→at, but be defensive in case
    // the migration hasn't run yet or was bypassed.
    const sched = schedule as { at?: string; atMs?: number | string };
    const atMs =
      typeof sched.atMs === "number" && Number.isFinite(sched.atMs) && sched.atMs > 0
        ? sched.atMs
        : typeof sched.atMs === "string"
          ? parseAbsoluteTimeMs(sched.atMs)
          : typeof sched.at === "string"
            ? parseAbsoluteTimeMs(sched.at)
            : null;
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
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
    return anchor + steps * everyMs;
  }

  const cron = resolveCronFromSchedule(schedule as { tz?: string; expr?: unknown; cron?: unknown });
  if (!cron) {
    return undefined;
  }
  let next = cron.nextRun(new Date(nowMs));
  if (!next) {
    return undefined;
  }
  let nextMs = next.getTime();
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

export function computePreviousRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind !== "cron") {
    return undefined;
  }
  const cron = resolveCronFromSchedule(schedule as { tz?: string; expr?: unknown; cron?: unknown });
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

export function clearCronScheduleCacheForTest(): void {
  cronEvalCache.clear();
}

export function getCronScheduleCacheSizeForTest(): number {
  return cronEvalCache.size;
}

export function getCronScheduleCacheMaxForTest(): number {
  return CRON_EVAL_CACHE_MAX;
}

export function hasCronInCacheForTest(expr: string, tz: string): boolean {
  return cronEvalCache.has(`${tz}\u0000${expr}`);
}
