// Shared schedule option resolver for cron create/edit commands.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CronSchedule } from "../../cron/types.js";
import {
  parseAt,
  parseCronStaggerMs,
  parseCronStreamCommandArgv,
  parsePositiveCronDurationMs,
} from "./shared.js";

type ScheduleOptionInput = {
  at?: unknown;
  cron?: unknown;
  every?: unknown;
  onExit?: unknown;
  onExitCwd?: unknown;
  streamCommand?: unknown;
  streamCwd?: unknown;
  streamMode?: unknown;
  streamMatch?: unknown;
  streamBatchMs?: unknown;
  streamMaxBatchBytes?: unknown;
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
  streamCommand: string[] | undefined;
  streamCwd: string | undefined;
  streamCwdSupplied: boolean;
  streamMode: "line" | "match";
  streamModeSupplied: boolean;
  streamMatch: string | undefined;
  streamMatchSupplied: boolean;
  streamBatchMs: number | undefined;
  streamMaxBatchBytes: number | undefined;
  requestedStaggerMs: number | undefined;
  tz: string | undefined;
};

/** Normalized schedule edit request, including patch-only updates for cron metadata. */
type CronEditScheduleRequest =
  | { kind: "direct"; schedule: CronSchedule }
  | { kind: "patch-existing-cron"; staggerMs: number | undefined; tz: string | undefined }
  | {
      kind: "patch-existing-stream";
      cwd: string | null | undefined;
      mode: "line" | "match" | undefined;
      match: string | null | undefined;
      batchMs: number | undefined;
      maxBatchBytes: number | undefined;
    }
  | { kind: "none" };

/** Resolve explicit `--at`, `--every`, or `--cron` options for cron creation. */
function resolveCronCreateSchedule(options: ScheduleOptionInput): CronSchedule {
  const normalized = normalizeScheduleOptions(options);
  if (normalized.onExitCwd && !normalized.onExitCommand) {
    throw new Error("--on-exit-cwd requires --on-exit.");
  }
  const chosen = countChosenSchedules(normalized);
  if (chosen !== 1) {
    throw new Error(
      "Choose exactly one schedule: --at, --every, --cron, --on-exit, or --stream-command",
    );
  }
  const schedule = resolveDirectSchedule(normalized);
  if (!schedule) {
    throw new Error(
      "Choose exactly one schedule: --at, --every, --cron, --on-exit, or --stream-command",
    );
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
    throw new Error(
      "Choose a positional schedule or one of --at, --every, --cron, --on-exit, or --stream-command.",
    );
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
  const streamPatchRequested = hasStreamSchedulePatch(normalized);
  if (streamPatchRequested && !normalized.streamCommand) {
    if (normalized.tz !== undefined || normalized.requestedStaggerMs !== undefined) {
      throw new Error("--tz/--stagger/--exact are not valid with stream schedule edits");
    }
    if (chosen > 0) {
      throw new Error("Choose at most one schedule change");
    }
    return {
      kind: "patch-existing-stream",
      cwd: normalized.streamCwdSupplied ? (normalized.streamCwd ?? null) : undefined,
      mode: normalized.streamModeSupplied ? normalized.streamMode : undefined,
      match: normalized.streamMatchSupplied ? (normalized.streamMatch ?? null) : undefined,
      batchMs: normalized.streamBatchMs,
      maxBatchBytes: normalized.streamMaxBatchBytes,
    };
  }
  if (chosen > 1) {
    throw new Error("Choose at most one schedule change");
  }
  const schedule = resolveDirectSchedule(normalized, { deferStreamMetadataValidation: true });
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

/** Apply stream metadata edits without requiring callers to restate the source argv. */
export function applyExistingStreamSchedulePatch(
  existingSchedule: CronSchedule,
  request: Extract<CronEditScheduleRequest, { kind: "patch-existing-stream" }>,
): CronSchedule {
  if (existingSchedule.kind !== "stream") {
    throw new Error("Current job is not a stream schedule; use --stream-command to convert first");
  }
  const mode = request.mode ?? existingSchedule.mode ?? "line";
  const requestedMatch =
    request.match === undefined ? existingSchedule.match : (request.match ?? undefined);
  if (mode === "match" && !requestedMatch) {
    throw new Error("--stream-match is required when --stream-mode=match");
  }
  if (mode === "line" && request.match) {
    throw new Error("--stream-match requires --stream-mode=match");
  }
  return {
    ...existingSchedule,
    cwd: request.cwd === undefined ? existingSchedule.cwd : (request.cwd ?? undefined),
    mode,
    match: mode === "match" ? requestedMatch : undefined,
    batchMs: request.batchMs ?? existingSchedule.batchMs,
    maxBatchBytes: request.maxBatchBytes ?? existingSchedule.maxBatchBytes,
  };
}

/** Validate a newly-created stream schedule after edit metadata has been merged. */
export function validateStreamScheduleMetadata(
  schedule: Extract<CronSchedule, { kind: "stream" }>,
): void {
  const mode = schedule.mode ?? "line";
  if (mode === "match" && !schedule.match) {
    throw new Error("--stream-match is required when --stream-mode=match");
  }
  if (mode === "line" && schedule.match) {
    throw new Error("--stream-match requires --stream-mode=match");
  }
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
  const streamModeSupplied = options.streamMode !== undefined;
  const suppliedStreamMode = normalizeOptionalString(options.streamMode);
  if (streamModeSupplied && !suppliedStreamMode) {
    throw new Error("--stream-mode must be line or match");
  }
  const streamModeRaw = suppliedStreamMode ?? "line";
  if (streamModeRaw !== "line" && streamModeRaw !== "match") {
    throw new Error("--stream-mode must be line or match");
  }
  const parsePositiveInteger = (value: unknown, flag: string): number | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`${flag} must be a positive integer`);
    }
    const text = String(value).trim();
    if (!/^\d+$/u.test(text)) {
      throw new Error(`${flag} must be a positive integer`);
    }
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${flag} must be a positive integer`);
    }
    return parsed;
  };
  return {
    at: normalizeOptionalString(options.at) ?? "",
    every: normalizeOptionalString(options.every) ?? "",
    cronExpr: normalizeOptionalString(options.cron) ?? "",
    onExitCommand: normalizeOptionalString(options.onExit) ?? "",
    onExitCwd: normalizeOptionalString(options.onExitCwd),
    streamCommand: parseCronStreamCommandArgv(options.streamCommand),
    streamCwd: normalizeOptionalString(options.streamCwd),
    streamCwdSupplied: options.streamCwd !== undefined,
    streamMode: streamModeRaw,
    streamModeSupplied,
    streamMatch: normalizeOptionalString(options.streamMatch),
    streamMatchSupplied: options.streamMatch !== undefined,
    streamBatchMs: parsePositiveInteger(options.streamBatchMs, "--stream-batch-ms"),
    streamMaxBatchBytes: parsePositiveInteger(
      options.streamMaxBatchBytes,
      "--stream-max-batch-bytes",
    ),
    tz: normalizeOptionalString(options.tz),
    requestedStaggerMs: parseCronStaggerMs({ staggerRaw, useExact }),
  };
}

function hasStreamSchedulePatch(options: NormalizedScheduleOptions): boolean {
  return (
    options.streamCwdSupplied ||
    options.streamModeSupplied ||
    options.streamMatchSupplied ||
    options.streamBatchMs !== undefined ||
    options.streamMaxBatchBytes !== undefined
  );
}

function countChosenSchedules(options: NormalizedScheduleOptions): number {
  return [
    Boolean(options.at),
    Boolean(options.every),
    Boolean(options.cronExpr),
    Boolean(options.onExitCommand),
    Boolean(options.streamCommand),
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

function resolveDirectSchedule(
  options: NormalizedScheduleOptions,
  behavior: { deferStreamMetadataValidation?: boolean } = {},
): CronSchedule | undefined {
  if (options.onExitCwd && !options.onExitCommand) {
    throw new Error("--on-exit-cwd requires --on-exit.");
  }
  if (hasStreamSchedulePatch(options) && !options.streamCommand) {
    throw new Error("Stream options require --stream-command.");
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
  if (options.streamCommand) {
    if (options.tz || options.requestedStaggerMs !== undefined) {
      throw new Error("--tz/--stagger/--exact are not valid with --stream-command");
    }
    const schedule: Extract<CronSchedule, { kind: "stream" }> = {
      kind: "stream",
      command: options.streamCommand,
      ...(options.streamCwd ? { cwd: options.streamCwd } : {}),
      mode: options.streamMode,
      ...(options.streamMatch ? { match: options.streamMatch } : {}),
      ...(options.streamBatchMs !== undefined ? { batchMs: options.streamBatchMs } : {}),
      ...(options.streamMaxBatchBytes !== undefined
        ? { maxBatchBytes: options.streamMaxBatchBytes }
        : {}),
    };
    if (!behavior.deferStreamMetadataValidation) {
      validateStreamScheduleMetadata(schedule);
    }
    return schedule;
  }
  return undefined;
}
