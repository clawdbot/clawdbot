/** Validates persisted cron job records before loading them from disk/state. */
import {
  asSafeIntegerInRange,
  MAX_DATE_TIMESTAMP_MS,
} from "@openclaw/normalization-core/number-coercion";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { compileSafeRegex } from "../security/safe-regex.js";
import { parseAbsoluteTimeMs } from "./parse.js";
import { isSystemOwnedCronPayloadKind, type CronJobState } from "./types.js";

const CRON_STATE_TIMESTAMP_FIELDS = [
  "nextRunAtMs",
  "scheduleActivatedAtMs",
  "startupCatchupAtMs",
  "pacedNextRunAtMs",
  "forcePreservedNextRunAtMs",
  "queuedAtMs",
  "runningAtMs",
  "lastRunAtMs",
  "lastFailureAlertAtMs",
  "lastTriggerEvalAtMs",
  "lastTriggerFireAtMs",
  "streamLastStartedAtMs",
  "streamLastExitAtMs",
] as const satisfies readonly (keyof CronJobState)[];

function isValidStateTimestamp(value: unknown): boolean {
  return asSafeIntegerInRange(value, { min: 0, max: MAX_DATE_TIMESTAMP_MS }) !== undefined;
}

function getInvalidCronJobStateTimestampField(state: unknown): string | undefined {
  const record = asRecord(state);
  const field = CRON_STATE_TIMESTAMP_FIELDS.find(
    (key) => record[key] !== undefined && !isValidStateTimestamp(record[key]),
  );
  if (field) {
    return field;
  }
  const atMs = asRecord(record.autoDisabled).atMs;
  return atMs !== undefined && !isValidStateTimestamp(atMs) ? "autoDisabled.atMs" : undefined;
}

/** Rejects caller-authored state timestamps that cannot round-trip through Date and SQLite. */
export function assertCronJobStateTimestamps(state: Partial<CronJobState>): void {
  const invalidField = getInvalidCronJobStateTimestampField(state);
  if (invalidField) {
    throw new Error(
      `cron state.${invalidField} must be a non-negative Date-valid integer timestamp`,
    );
  }
}

/** Structural rejection code for persisted cron jobs that cannot be loaded safely. */
type InvalidPersistedCronJobReason =
  | "missing-id"
  | "missing-schedule"
  | "invalid-schedule"
  | "invalid-state"
  | "unsatisfiable-schedule"
  | "invalid-trigger"
  | "missing-payload"
  | "invalid-payload";

/** Returns the first structural reason a persisted cron job cannot be loaded safely. */
export function getInvalidPersistedCronJobReason(
  candidate: Record<string, unknown>,
): InvalidPersistedCronJobReason | null {
  const id = candidate.id;
  if (typeof id !== "string" || !id.trim()) {
    return "missing-id";
  }
  if (getInvalidCronJobStateTimestampField(candidate.state)) {
    return "invalid-state";
  }
  const schedule = candidate.schedule;
  if (!schedule || Array.isArray(schedule)) {
    return "missing-schedule";
  }
  if (typeof schedule === "string") {
    // Legacy shorthand schedules are normalized later by the full cron parser;
    // this guard only rejects shapes that cannot be persisted or quarantined.
    return null;
  }
  if (typeof schedule !== "object") {
    return "missing-schedule";
  }
  const scheduleRecord = schedule as Record<string, unknown>;
  const scheduleKind = scheduleRecord.kind;
  if (
    scheduleKind !== "at" &&
    scheduleKind !== "every" &&
    scheduleKind !== "cron" &&
    scheduleKind !== "on-exit" &&
    scheduleKind !== "stream"
  ) {
    return "invalid-schedule";
  }
  if (scheduleKind === "at") {
    const at = scheduleRecord.at;
    if (typeof at !== "string" || parseAbsoluteTimeMs(at) === null) {
      return "invalid-schedule";
    }
  }
  if (scheduleKind === "every") {
    const everyMs = scheduleRecord.everyMs;
    const anchorMs = scheduleRecord.anchorMs;
    if (
      asSafeIntegerInRange(everyMs, { min: 1, max: MAX_DATE_TIMESTAMP_MS }) === undefined ||
      (anchorMs !== undefined &&
        asSafeIntegerInRange(anchorMs, { min: 0, max: MAX_DATE_TIMESTAMP_MS }) === undefined)
    ) {
      return "invalid-schedule";
    }
  }
  if (scheduleKind === "cron") {
    const expr = scheduleRecord.expr;
    const staggerMs = scheduleRecord.staggerMs;
    if (
      typeof expr !== "string" ||
      expr.trim().length === 0 ||
      (staggerMs !== undefined &&
        asSafeIntegerInRange(staggerMs, { min: 0, max: MAX_DATE_TIMESTAMP_MS }) === undefined)
    ) {
      return "invalid-schedule";
    }
  }
  if (scheduleKind === "on-exit") {
    const command = scheduleRecord.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      return "invalid-schedule";
    }
  }
  if (scheduleKind === "stream") {
    const command = scheduleRecord.command;
    const mode = scheduleRecord.mode ?? "line";
    // Batching fields are optional but, when present, must be safe integers:
    // cronStreamScheduleKey -> resolveCronStreamBatching throws otherwise, and
    // one such throw would abort the single-pass stream reconcile and block
    // every valid stream job. Quarantine the row here instead.
    const batchFieldValid = (value: unknown) =>
      value === undefined || asSafeIntegerInRange(value, {}) !== undefined;
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.some((value) => typeof value !== "string" || value.length === 0) ||
      (mode !== "line" && mode !== "match") ||
      (mode === "match" && typeof scheduleRecord.match !== "string") ||
      (mode === "line" && scheduleRecord.match !== undefined) ||
      !batchFieldValid(scheduleRecord.batchMs) ||
      !batchFieldValid(scheduleRecord.maxBatchBytes)
    ) {
      return "invalid-schedule";
    }
    if (mode === "match") {
      if (!compileSafeRegex(scheduleRecord.match as string)) {
        return "invalid-schedule";
      }
    }
  }
  if ("trigger" in candidate) {
    const trigger = candidate.trigger;
    if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
      return "invalid-trigger";
    }
    const script = (trigger as Record<string, unknown>).script;
    if (
      typeof script !== "string" ||
      script.trim().length === 0 ||
      scheduleKind === "at" ||
      scheduleKind === "on-exit"
    ) {
      return "invalid-trigger";
    }
  }
  const payload = candidate.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "missing-payload";
  }
  const payloadRecord = payload as Record<string, unknown>;
  const payloadKind = payloadRecord.kind;
  if (
    payloadKind !== "systemEvent" &&
    payloadKind !== "agentTurn" &&
    payloadKind !== "command" &&
    payloadKind !== "script" &&
    !isSystemOwnedCronPayloadKind(payloadKind)
  ) {
    return "invalid-payload";
  }
  const requiredText =
    payloadKind === "systemEvent"
      ? payloadRecord.text
      : payloadKind === "agentTurn"
        ? payloadRecord.message
        : payloadKind === "script"
          ? payloadRecord.script
          : undefined;
  if (
    (payloadKind === "systemEvent" || payloadKind === "agentTurn" || payloadKind === "script") &&
    (typeof requiredText !== "string" || (payloadKind !== "systemEvent" && !requiredText.trim()))
  ) {
    return "invalid-payload";
  }
  if (payloadKind === "command") {
    const argv = payloadRecord.argv;
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.some((value) => typeof value !== "string" || value.length === 0)
    ) {
      return "invalid-payload";
    }
    if (scheduleKind === "stream") {
      return "invalid-payload";
    }
  }
  return null;
}
