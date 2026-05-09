import type { CronSchedule } from "../../cron/types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { parseAt, parseCronStaggerMs, parseDurationMs } from "./shared.js";

type ScheduleOptionInput = {
  at?: unknown;
  cron?: unknown;
  every?: unknown;
  exact?: unknown;
  stagger?: unknown;
  tz?: unknown;
};

type NormalizedScheduleOptions = {
  at: string;
  cronExpr: string;
  every: string;
  requestedStaggerMs: number | undefined;
  tz: string | undefined;
};

export type CronEditScheduleRequest =
  | { kind: "direct"; schedule: CronSchedule }
  | { kind: "patch-existing-cron"; staggerMs: number | undefined; tz: string | undefined }
  | { kind: "none" };

export function resolveCronCreateSchedule(options: ScheduleOptionInput): CronSchedule {
  const normalized = normalizeScheduleOptions(options);
  const chosen = countChosenSchedules(normalized);
  if (chosen !== 1) {
    throw new Error("Choose exactly one schedule: --at, --every, or --cron");
  }
  const schedule = resolveDirectSchedule(normalized);
  if (!schedule) {
    throw new Error("Choose exactly one schedule: --at, --every, or --cron");
  }
  return schedule;
}

export function resolveCronEditScheduleRequest(
  options: ScheduleOptionInput,
): CronEditScheduleRequest {
  const normalized = normalizeScheduleOptions(options);
  const chosen = countChosenSchedules(normalized);
  if (chosen > 1) {
    throw new Error("Choose at most one schedule change");
  }
  const schedule = resolveDirectSchedule(normalized);
  if (schedule) {
    return { kind: "direct", schedule };
  }
  if (normalized.requestedStaggerMs !== undefined || normalized.tz !== undefined) {
    return {
      kind: "patch-existing-cron",
      tz: normalized.tz,
      staggerMs: normalized.requestedStaggerMs,
    };
  }
  return { kind: "none" };
}

export function applyExistingCronSchedulePatch(
  existingSchedule: CronSchedule,
  request: Extract<CronEditScheduleRequest, { kind: "patch-existing-cron" }>,
): CronSchedule {
  if (existingSchedule.kind !== "cron") {
    throw new Error("Current job is not a cron schedule; use --cron to convert first");
  }
  return {
    kind: "cron",
    expr: existingSchedule.expr,
    tz: request.tz ?? existingSchedule.tz,
    staggerMs: request.staggerMs !== undefined ? request.staggerMs : existingSchedule.staggerMs,
  };
}

function normalizeScheduleOptions(options: ScheduleOptionInput): NormalizedScheduleOptions {
  const staggerRaw = normalizeOptionalString(options.stagger) ?? "";
  const useExact = Boolean(options.exact);
  if (staggerRaw && useExact) {
    throw new Error("Choose either --stagger or --exact, not both");
  }
  return {
    at: normalizeOptionalString(options.at) ?? "",
    every: normalizeOptionalString(options.every) ?? "",
    cronExpr: normalizeOptionalString(options.cron) ?? "",
    tz: normalizeOptionalString(options.tz),
    requestedStaggerMs: parseCronStaggerMs({ staggerRaw, useExact }),
  };
}

function countChosenSchedules(options: NormalizedScheduleOptions): number {
  return [Boolean(options.at), Boolean(options.every), Boolean(options.cronExpr)].filter(Boolean)
    .length;
}

function resolveDirectSchedule(options: NormalizedScheduleOptions): CronSchedule | undefined {
  if (options.tz && options.every) {
    throw new Error("--tz is only valid with --cron or offset-less --at");
  }
  if (options.requestedStaggerMs !== undefined && (options.at || options.every)) {
    throw new Error("--stagger/--exact are only valid for cron schedules");
  }
  if (options.at) {
    const atIso = parseAt(options.at, options.tz);
    if (!atIso) {
      throw new Error("Invalid --at. Use an ISO timestamp or a duration like 20m.");
    }
    return { kind: "at", at: atIso };
  }
  if (options.every) {
    const everyMs = parseDurationMs(options.every);
    if (!everyMs) {
      throw new Error("Invalid --every. Use a duration like 10m, 1h, or 1d.");
    }
    return { kind: "every", everyMs };
  }
  if (options.cronExpr) {
    return {
      kind: "cron",
      expr: options.cronExpr,
      tz: options.tz,
      staggerMs: options.requestedStaggerMs,
    };
  }
  return undefined;
}
