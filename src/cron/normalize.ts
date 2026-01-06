import type { CronJobCreate, CronJobPatch } from "./types.js";

type UnknownRecord = Record<string, unknown>;

type NormalizeOptions = {
  applyDefaults?: boolean;
};

const DEFAULT_OPTIONS: NormalizeOptions = {
  applyDefaults: false,
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceSchedule(schedule: UnknownRecord) {
  const next: UnknownRecord = { ...schedule };
  const kind = typeof schedule.kind === "string" ? schedule.kind : undefined;
  if (!kind) {
    if (typeof schedule.atMs === "number") next.kind = "at";
    else if (typeof schedule.everyMs === "number") next.kind = "every";
    else if (typeof schedule.expr === "string") next.kind = "cron";
  }
  return next;
}

function coercePayload(payload: UnknownRecord) {
  const next: UnknownRecord = { ...payload };
  const kind = typeof payload.kind === "string" ? payload.kind : undefined;
  if (!kind) {
    if (typeof payload.text === "string") next.kind = "systemEvent";
    else if (typeof payload.message === "string") next.kind = "agentTurn";
  }
  return next;
}

function unwrapJob(raw: UnknownRecord) {
  if (isRecord(raw.data)) return raw.data;
  if (isRecord(raw.job)) return raw.job;
  return raw;
}

export function normalizeCronJobInput(
  raw: unknown,
  options: NormalizeOptions = DEFAULT_OPTIONS,
): UnknownRecord | null {
  if (!isRecord(raw)) return null;
  const base = unwrapJob(raw);
  const next: UnknownRecord = { ...base };

  if (isRecord(base.schedule)) {
    next.schedule = coerceSchedule(base.schedule);
  }

  if (isRecord(base.payload)) {
    next.payload = coercePayload(base.payload);
  }

  if (options.applyDefaults) {
    if (!next.wakeMode) next.wakeMode = "next-heartbeat";
    if (!next.sessionTarget && isRecord(next.payload)) {
      const kind =
        typeof next.payload.kind === "string" ? next.payload.kind : "";
      if (kind === "systemEvent") next.sessionTarget = "main";
      if (kind === "agentTurn") next.sessionTarget = "isolated";
    }
  }

  return next;
}

export function normalizeCronJobCreate(
  raw: unknown,
  options?: NormalizeOptions,
): CronJobCreate | null {
  return normalizeCronJobInput(raw, {
    applyDefaults: true,
    ...options,
  }) as CronJobCreate | null;
}

export function normalizeCronJobPatch(
  raw: unknown,
  options?: NormalizeOptions,
): CronJobPatch | null {
  return normalizeCronJobInput(raw, {
    applyDefaults: false,
    ...options,
  }) as CronJobPatch | null;
}
