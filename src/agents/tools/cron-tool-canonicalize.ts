import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "../../utils.js";

const CRON_SCHEDULE_KINDS = ["at", "every", "cron"] as const;
const CRON_PAYLOAD_KINDS = ["systemEvent", "agentTurn"] as const;
const CRON_FLAT_PAYLOAD_KEYS = [
  "message",
  "text",
  "model",
  "fallbacks",
  "toolsAllow",
  "thinking",
  "timeoutSeconds",
  "lightContext",
  "allowUnsafeExternalContent",
] as const;
const CRON_FLAT_SCHEDULE_KEYS = [
  "kind",
  "at",
  "atMs",
  "every",
  "everyMs",
  "anchorMs",
  "cron",
  "expr",
  "tz",
  "stagger",
  "staggerMs",
  "exact",
] as const;
const CRON_RECOVERABLE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "schedule",
  "sessionTarget",
  "wakeMode",
  "payload",
  "delivery",
  "enabled",
  "description",
  "deleteAfterRun",
  "agentId",
  "sessionKey",
  "failureAlert",
  ...CRON_FLAT_PAYLOAD_KEYS,
  ...CRON_FLAT_SCHEDULE_KEYS,
]);

function isCronScheduleKind(value: unknown): value is (typeof CRON_SCHEDULE_KINDS)[number] {
  return value === "at" || value === "every" || value === "cron";
}

function isCronPayloadKind(value: unknown): value is (typeof CRON_PAYLOAD_KINDS)[number] {
  return value === "systemEvent" || value === "agentTurn";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArrayOrNull(value: unknown): boolean {
  return (
    value === null || (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

function moveDefinedField(params: {
  source: Record<string, unknown>;
  target: Record<string, unknown>;
  from: string;
  to?: string;
}): boolean {
  if (params.source[params.from] === undefined) {
    return false;
  }
  params.target[params.to ?? params.from] = params.source[params.from];
  delete params.source[params.from];
  return true;
}

function setScheduleAtMs(schedule: Record<string, unknown>, value: unknown): void {
  const atMs = typeof value === "number" ? value : Number(value);
  schedule.at = Number.isFinite(atMs) ? (timestampMsToIsoString(Math.floor(atMs)) ?? value) : value;
}

function canonicalizeCronToolSchedule(value: Record<string, unknown>): void {
  const schedule = isRecord(value.schedule) ? { ...value.schedule } : {};
  let hasSchedule = isRecord(value.schedule);

  if (schedule.atMs !== undefined) {
    setScheduleAtMs(schedule, schedule.atMs);
    delete schedule.atMs;
    if (!isCronScheduleKind(schedule.kind)) {
      schedule.kind = "at";
    }
  }
  if (schedule.everyMs === undefined && schedule.every !== undefined) {
    schedule.everyMs = schedule.every;
    delete schedule.every;
  }
  if (schedule.expr === undefined && schedule.cron !== undefined) {
    schedule.expr = schedule.cron;
    delete schedule.cron;
  }
  if (schedule.staggerMs === undefined && schedule.stagger !== undefined) {
    schedule.staggerMs = schedule.stagger;
    delete schedule.stagger;
  }
  if (schedule.exact === true && schedule.staggerMs === undefined) {
    schedule.staggerMs = 0;
  }
  delete schedule.exact;

  if (isCronScheduleKind(value.kind) && !isCronScheduleKind(schedule.kind)) {
    schedule.kind = value.kind;
    delete value.kind;
    hasSchedule = true;
  }

  const movedAt = moveDefinedField({ source: value, target: schedule, from: "at" });
  if (movedAt && !isCronScheduleKind(schedule.kind)) {
    schedule.kind = "at";
  }

  if (value.atMs !== undefined) {
    setScheduleAtMs(schedule, value.atMs);
    delete value.atMs;
    if (!isCronScheduleKind(schedule.kind)) {
      schedule.kind = "at";
    }
    hasSchedule = true;
  }

  const movedEveryMs =
    moveDefinedField({ source: value, target: schedule, from: "everyMs" }) ||
    moveDefinedField({ source: value, target: schedule, from: "every", to: "everyMs" });
  if (movedEveryMs && !isCronScheduleKind(schedule.kind)) {
    schedule.kind = "every";
  }

  const movedCron =
    moveDefinedField({ source: value, target: schedule, from: "cron", to: "expr" }) ||
    moveDefinedField({ source: value, target: schedule, from: "expr" });
  if (movedCron && !isCronScheduleKind(schedule.kind)) {
    schedule.kind = "cron";
  }

  for (const key of ["anchorMs", "tz", "staggerMs"] as const) {
    hasSchedule = moveDefinedField({ source: value, target: schedule, from: key }) || hasSchedule;
  }
  hasSchedule =
    moveDefinedField({ source: value, target: schedule, from: "stagger", to: "staggerMs" }) ||
    hasSchedule;

  if (value.exact === true && schedule.staggerMs === undefined) {
    schedule.staggerMs = 0;
    hasSchedule = true;
  }
  delete value.exact;

  if (!isCronScheduleKind(schedule.kind)) {
    if (schedule.at !== undefined) {
      schedule.kind = "at";
    } else if (schedule.everyMs !== undefined) {
      schedule.kind = "every";
    } else if (schedule.expr !== undefined) {
      schedule.kind = "cron";
    }
  }

  if (hasSchedule || Object.keys(schedule).length > 0) {
    value.schedule = schedule;
  }
}

function canonicalizeCronToolPayload(value: Record<string, unknown>): void {
  const payload = isRecord(value.payload) ? { ...value.payload } : {};
  let hasPayload = isRecord(value.payload);

  for (const key of CRON_FLAT_PAYLOAD_KEYS) {
    hasPayload = moveDefinedField({ source: value, target: payload, from: key }) || hasPayload;
  }

  if (isCronPayloadKind(value.kind) && !isCronPayloadKind(payload.kind)) {
    payload.kind = value.kind;
    delete value.kind;
    hasPayload = true;
  }

  if (!isCronPayloadKind(payload.kind)) {
    const hasAgentTurnSignal =
      isNonEmptyString(payload.message) ||
      isNonEmptyString(payload.model) ||
      isNonEmptyString(payload.thinking) ||
      typeof payload.timeoutSeconds === "number" ||
      typeof payload.lightContext === "boolean" ||
      typeof payload.allowUnsafeExternalContent === "boolean" ||
      (payload.fallbacks !== undefined && isStringArrayOrNull(payload.fallbacks)) ||
      (payload.toolsAllow !== undefined && isStringArrayOrNull(payload.toolsAllow));
    if (hasAgentTurnSignal) {
      payload.kind = "agentTurn";
    } else if (isNonEmptyString(payload.text)) {
      payload.kind = "systemEvent";
    }
  }

  if (hasPayload || Object.keys(payload).length > 0) {
    value.payload = payload;
  }
}

export function canonicalizeCronToolObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const unwrapped = isRecord(value.data) ? value.data : isRecord(value.job) ? value.job : value;
  const next = { ...unwrapped };
  canonicalizeCronToolSchedule(next);
  canonicalizeCronToolPayload(next);
  return next;
}

export function isEmptyRecoveredCronPatch(value: unknown): boolean {
  if (!isRecord(value)) {
    return true;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 0 ||
    (keys.length === 1 &&
      keys[0] === "payload" &&
      isRecord(value.payload) &&
      Object.keys(value.payload).length === 0)
  );
}

export function recoverCronObjectFromFlatParams(params: Record<string, unknown>): {
  found: boolean;
  value: Record<string, unknown>;
} {
  const value: Record<string, unknown> = {};
  let found = false;
  for (const key of Object.keys(params)) {
    if (CRON_RECOVERABLE_OBJECT_KEYS.has(key) && params[key] !== undefined) {
      value[key] = params[key];
      found = true;
    }
  }
  return { found, value: canonicalizeCronToolObject(value) };
}

export function hasCronCreateSignal(value: Record<string, unknown>): boolean {
  return (
    value.schedule !== undefined ||
    value.at !== undefined ||
    value.atMs !== undefined ||
    value.everyMs !== undefined ||
    value.cron !== undefined ||
    value.expr !== undefined ||
    value.payload !== undefined ||
    value.message !== undefined ||
    value.text !== undefined
  );
}
