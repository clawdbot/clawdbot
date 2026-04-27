import type { CronJob } from "./types.js";

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function schedulePayloadFromRecord(
  schedule: Record<string, unknown>,
):
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | undefined {
  const rawKind = readString(schedule, "kind")?.toLowerCase();
  const expr = readString(schedule, "expr") ?? readString(schedule, "cron");
  const at = readString(schedule, "at");
  const atMs = readNumber(schedule, "atMs");
  const everyMs = readNumber(schedule, "everyMs");
  const anchorMs = readNumber(schedule, "anchorMs");
  const tz = readString(schedule, "tz");
  const staggerMs = readNumber(schedule, "staggerMs");
  const kind =
    rawKind === "at" || rawKind === "every" || rawKind === "cron"
      ? rawKind
      : at || atMs !== undefined
        ? "at"
        : everyMs !== undefined
          ? "every"
          : expr
            ? "cron"
            : undefined;

  if (kind === "at") {
    return at
      ? { kind: "at", at }
      : atMs !== undefined
        ? { kind: "at", at: String(atMs) }
        : undefined;
  }
  if (kind === "every" && everyMs !== undefined) {
    return { kind: "every", everyMs, anchorMs };
  }
  if (kind === "cron" && expr) {
    return { kind: "cron", expr, tz, staggerMs };
  }
  return undefined;
}

function resolveSchedulePayload(
  job: { schedule?: unknown } & Record<string, unknown>,
): ReturnType<typeof schedulePayloadFromRecord> {
  if (job.schedule && typeof job.schedule === "object" && !Array.isArray(job.schedule)) {
    return schedulePayloadFromRecord(job.schedule as Record<string, unknown>);
  }
  return schedulePayloadFromRecord(job);
}

export function cronScheduleIdentity(
  job: Pick<CronJob, "schedule"> & { enabled?: boolean },
): string {
  const schedule = resolveSchedulePayload(job as unknown as Record<string, unknown>);
  if (!schedule) {
    throw new Error("Unsupported cron schedule kind");
  }
  return JSON.stringify({
    version: 1,
    enabled: job.enabled ?? true,
    schedule,
  });
}

export function tryCronScheduleIdentity(
  job: { schedule?: unknown; enabled?: unknown } & Record<string, unknown>,
): string | undefined {
  const schedule = resolveSchedulePayload(job);
  if (!schedule) {
    return undefined;
  }
  return JSON.stringify({
    version: 1,
    enabled: typeof job.enabled === "boolean" ? job.enabled : true,
    schedule,
  });
}

export function cronSchedulingInputsEqual(
  previous: Pick<CronJob, "schedule"> & { enabled?: boolean },
  next: Pick<CronJob, "schedule"> & { enabled?: boolean },
): boolean {
  return cronScheduleIdentity(previous) === cronScheduleIdentity(next);
}
