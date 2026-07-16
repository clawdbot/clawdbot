/**
 * Cron tool argument canonicalization.
 *
 * Recovers flat or partial model/tool inputs into the structured cron job/patch shape.
 */
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "../../utils.js";
import { isStringOption } from "../../utils/string-readers.js";

const CRON_SCHEDULE_KINDS = ["at", "every", "cron", "on-exit"] as const;
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
  "command",
  "cwd",
] as const;
const CRON_RECOVERABLE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "declarationKey",
  "displayName",
  "owner",
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
  "namePayload",
  "scheduleKind",
  "sessionTargetName",
  ...CRON_FLAT_PAYLOAD_KEYS,
  ...CRON_FLAT_SCHEDULE_KEYS,
]);

function isCronScheduleKind(value: unknown): value is (typeof CRON_SCHEDULE_KINDS)[number] {
  return isStringOption(value, CRON_SCHEDULE_KINDS);
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

function repairConcatenatedCronToolKeys(value: Record<string, unknown>): void {
  // Some small/local tool-call parsers can return valid JSON with adjacent cron
  // key names merged. Recover only the observed schema-specific pairs before
  // strict gateway validation sees the malformed property names.
  if (!isRecord(value.payload) && isRecord(value.namePayload)) {
    value.payload = { ...value.namePayload };
  }
  const rawScheduleKind = value.scheduleKind;
  if (!isRecord(value.schedule)) {
    if (isRecord(rawScheduleKind)) {
      value.schedule = { ...rawScheduleKind };
    } else if (isCronScheduleKind(rawScheduleKind)) {
      value.schedule = { kind: rawScheduleKind };
    }
  } else if (isCronScheduleKind(rawScheduleKind) && !isCronScheduleKind(value.schedule.kind)) {
    value.schedule = { ...value.schedule, kind: rawScheduleKind };
  }
  if (!isNonEmptyString(value.name) && isNonEmptyString(value.sessionTargetName)) {
    value.name = value.sessionTargetName;
  }
  delete value.namePayload;
  delete value.scheduleKind;
  delete value.sessionTargetName;
}

function setScheduleAtMs(schedule: Record<string, unknown>, value: unknown): void {
  const atMs = typeof value === "number" ? value : Number(value);
  // Invalid/out-of-range timestamps stay raw so cron gateway validation reports the user error.
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

  const movedCommand = moveDefinedField({ source: value, target: schedule, from: "command" });
  if (movedCommand && !isCronScheduleKind(schedule.kind)) {
    schedule.kind = "on-exit";
  }

  for (const key of ["anchorMs", "tz", "staggerMs", "cwd"] as const) {
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
    } else if (schedule.command !== undefined) {
      schedule.kind = "on-exit";
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
      payload.model === null ||
      isNonEmptyString(payload.thinking) ||
      typeof payload.timeoutSeconds === "number" ||
      typeof payload.lightContext === "boolean" ||
      typeof payload.allowUnsafeExternalContent === "boolean" ||
      (payload.fallbacks !== undefined && isStringArrayOrNull(payload.fallbacks));
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

/**
 * Normalizes whitespace-padded cron object keys. Some tool-call
 * extraction/serialization pipelines can produce keys with trailing spaces
 * (e.g. "schedule " instead of "schedule"), which causes strict gateway
 * validation to reject the job with "unexpected property" errors.
 *
 * Only recognized CRON_RECOVERABLE_OBJECT_KEYS are trimmed — arbitrary keys
 * (including special ones like "__proto__") are never mutated.
 *
 * If both the padded and canonical form of a key exist (e.g. "schedule " and
 * "schedule"), the padded key is preserved so strict gateway validation
 * rejects the ambiguous input rather than silently picking one value.
 */
function repairPaddedCronKeys(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    const trimmed = key.trim();
    if (trimmed !== key && CRON_RECOVERABLE_OBJECT_KEYS.has(trimmed)) {
      if (!(trimmed in value)) {
        value[trimmed] = value[key];
        delete value[key];
      }
      // When the canonical key already exists, preserve the padded duplicate
      // so strict gateway validation sees the conflict and rejects the input.
    }
  }
}

/** Converts model-friendly cron tool shorthands into the nested gateway job/patch shape. */
export function canonicalizeCronToolObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const unwrapped = isRecord(value.data) ? value.data : isRecord(value.job) ? value.job : value;
  const next = { ...unwrapped };
  repairPaddedCronKeys(next);
  repairConcatenatedCronToolKeys(next);
  canonicalizeCronToolSchedule(next);
  canonicalizeCronToolPayload(next);
  return next;
}

/** Detects recovered update patches that contain no meaningful cron fields after normalization. */
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

/** Recovers cron job or patch fields that a model flattened beside the action arguments. */
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

/** Checks whether a recovered flat object has enough schedule/payload signal to create a job. */
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
