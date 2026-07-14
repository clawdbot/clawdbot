// Shared schedule option resolver for cron create/edit commands.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CronSchedule } from "../../cron/types.js";
import { parseAt, parseCronStaggerMs, parsePositiveCronDurationMs } from "./shared.js";

type ScheduleOptionInput = {
  at?: unknown;
  cron?: unknown;
  every?: unknown;
  onExit?: unknown;
  onExitCwd?: unknown;
  exact?: unknown;
  stagger?: unknown;
  tz?: unknown;
};

type PositionalScheduleInput = {
  positionalSchedule?: unknown;
};

type NormalizedScheduleOptions = {
  at: string;
  cronExpr: string;
  every: string;
  onExitCommand: string;
  onExitCwd: string | undefined;
  requestedStaggerMs: number | undefined;
  tz: string | undefined;
};

/** Normalized schedule edit request, including patch-only updates for cron metadata. */
type CronEditScheduleRequest =
  | { kind: "direct"; schedule: CronSchedule }
  | { kind: "patch-existing-cron"; staggerMs: number | undefined; tz: string | undefined }
  | { kind: "none" };

/** Resolve explicit `--at`, `--every`, or `--cron` options for cron creation. */
function resolveCronCreateSchedule(options: ScheduleOptionInput): CronSchedule {
  const normalized = normalizeScheduleOptions(options);
  if (normalized.onExitCwd && !normalized.onExitCommand) {
    throw new Error("--on-exit-cwd requires --on-exit.");
  }
  const chosen = countChosenSchedules(normalized);
  if (chosen !== 1) {
    throw new Error("Choose exactly one schedule: --at, --every, --cron, or --on-exit");
  }
  const schedule = resolveDirectSchedule(normalized);
  if (!schedule) {
    throw new Error("Choose exactly one schedule: --at, --every, --cron, or --on-exit");
  }
  return schedule;
}

/** Resolve cron creation schedule from either a positional shorthand or explicit flags. */
export function resolveCronCreateScheduleFromArgs(
  options: ScheduleOptionInput & PositionalScheduleInput,
): CronSchedule {
  const positionalSchedule = normalizeOptionalString(options.positionalSchedule);
  if (!positionalSchedule) {
    return resolveCronCreateSchedule(options);
  }
  const normalized = normalizeScheduleOptions(options);
  if (countChosenSchedules(normalized) > 0) {
    throw new Error("Choose a positional schedule or one of --at, --every, --cron, or --on-exit.");
  }
  const every = parseEverySchedule(positionalSchedule);
  return resolveCronCreateSchedule({
    ...options,
    at: every
      ? undefined
      : looksLikeCronExpression(positionalSchedule)
        ? undefined
        : positionalSchedule,
    cron: looksLikeCronExpression(positionalSchedule) ? positionalSchedule : undefined,
    every,
  });
}

/** Resolve a cron edit request, allowing at most one direct schedule replacement. */
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

/** Apply `--tz`, `--stagger`, or `--exact` metadata changes to an existing cron schedule. */
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
    onExitCommand: normalizeOptionalString(options.onExit) ?? "",
    onExitCwd: normalizeOptionalString(options.onExitCwd),
    tz: normalizeOptionalString(options.tz),
    requestedStaggerMs: parseCronStaggerMs({ staggerRaw, useExact }),
  };
}

function countChosenSchedules(options: NormalizedScheduleOptions): number {
  return [
    Boolean(options.at),
    Boolean(options.every),
    Boolean(options.cronExpr),
    Boolean(options.onExitCommand),
  ].filter(Boolean).length;
}

function parseEverySchedule(value: string): string | undefined {
  const match = /^every\s+(.+)$/iu.exec(value.trim());
  return match?.[1]?.trim() || undefined;
}

function looksLikeCronExpression(value: string): boolean {
  const parts = value.trim().split(/\s+/u);
  return parts.length === 5 || parts.length === 6;
}

function resolveDirectSchedule(options: NormalizedScheduleOptions): CronSchedule | undefined {
  if (options.onExitCwd && !options.onExitCommand) {
    throw new Error("--on-exit-cwd requires --on-exit.");
  }
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
    const everyMs = parsePositiveCronDurationMs(options.every);
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
  if (options.onExitCommand) {
    if (options.tz || options.requestedStaggerMs !== undefined) {
      throw new Error("--tz/--stagger/--exact are not valid with --on-exit");
    }
    return {
      kind: "on-exit",
      command: options.onExitCommand,
      ...(options.onExitCwd ? { cwd: options.onExitCwd } : {}),
    };
  }
  return undefined;
}
