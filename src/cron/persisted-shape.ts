import { compileSafeRegex } from "../security/safe-regex.js";
/** Validates persisted cron job records before loading them from disk/state. */
import { parseAbsoluteTimeMs } from "./parse.js";

/** Structural rejection code for persisted cron jobs that cannot be loaded safely. */
type InvalidPersistedCronJobReason =
  | "missing-id"
  | "missing-schedule"
  | "invalid-schedule"
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
    if (typeof everyMs !== "number" || !Number.isFinite(everyMs) || everyMs <= 0) {
      return "invalid-schedule";
    }
  }
  if (scheduleKind === "cron") {
    const expr = scheduleRecord.expr;
    if (typeof expr !== "string" || expr.trim().length === 0) {
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
      value === undefined || (typeof value === "number" && Number.isSafeInteger(value));
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
    payloadKind !== "heartbeat"
  ) {
    return "invalid-payload";
  }
  if (payloadKind === "systemEvent") {
    const text = payloadRecord.text;
    if (typeof text !== "string") {
      return "invalid-payload";
    }
  }
  if (payloadKind === "agentTurn") {
    const message = payloadRecord.message;
    if (typeof message !== "string" || message.trim().length === 0) {
      return "invalid-payload";
    }
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
  if (payloadKind === "script") {
    const script = payloadRecord.script;
    if (typeof script !== "string" || script.trim().length === 0) {
      return "invalid-payload";
    }
  }
  return null;
}
