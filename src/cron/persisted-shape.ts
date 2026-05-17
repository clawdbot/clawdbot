import { parseAbsoluteTimeMs } from "./parse.js";

export type InvalidPersistedCronJobReason =
  | "missing-id"
  | "missing-schedule"
  | "invalid-schedule"
  | "missing-payload"
  | "invalid-payload";

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
    return null;
  }
  if (typeof schedule !== "object") {
    return "missing-schedule";
  }
  const scheduleRecord = schedule as Record<string, unknown>;
  const scheduleKind = scheduleRecord.kind;
  if (scheduleKind !== "at" && scheduleKind !== "every" && scheduleKind !== "cron") {
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
  const payload = candidate.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "missing-payload";
  }
  const payloadRecord = payload as Record<string, unknown>;
  const payloadKind = payloadRecord.kind;
  if (payloadKind !== "systemEvent" && payloadKind !== "agentTurn") {
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
  return null;
}
