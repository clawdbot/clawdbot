import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { coerceFiniteScheduleNumber } from "./schedule-number.js";
import { normalizeCronStaggerMs } from "./stagger.js";

type CronScheduleIdentityInput = { schedule?: unknown; enabled?: unknown } & Record<
  string,
  unknown
>;

function readString(record: Record<string, unknown>, key: string): string | undefined {
  return normalizeOptionalString(record[key]);
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  return coerceFiniteScheduleNumber(record[key]);
}

function readStaggerMs(record: Record<string, unknown>): number | undefined {
  return normalizeCronStaggerMs(record.staggerMs);
}

function schedulePayloadFromRecord(
  schedule: Record<string, unknown>,
):
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | undefined {
  const rawKind = readString(schedule, "kind")?.toLowerCase();
  const expr = readString(schedule, "expr");
  const at = readString(schedule, "at");
  const everyMs = readNumber(schedule, "everyMs");
  const anchorMs = readNumber(schedule, "anchorMs");
  const tz = readString(schedule, "tz");
  const staggerMs = readStaggerMs(schedule);
  const kind =
    rawKind === "at" || rawKind === "every" || rawKind === "cron"
      ? rawKind
      : at
        ? "at"
        : everyMs !== undefined
          ? "every"
          : expr
            ? "cron"
            : undefined;

  if (kind === "at") {
    return at ? { kind: "at", at } : undefined;
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
  job: CronScheduleIdentityInput,
): ReturnType<typeof schedulePayloadFromRecord> {
  if (job.schedule && typeof job.schedule === "object" && !Array.isArray(job.schedule)) {
    return schedulePayloadFromRecord(job.schedule as Record<string, unknown>);
  }
  return undefined;
}

/** Builds a stable scheduling identity for deciding whether stored timer state is still valid. */
export function tryCronScheduleIdentity(job: CronScheduleIdentityInput): string | undefined {
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

/** Compares two cron jobs by the normalized inputs that affect next-run computation. */
export function cronSchedulingInputsEqual(
  previous: CronScheduleIdentityInput,
  next: CronScheduleIdentityInput,
): boolean {
  const previousIdentity = tryCronScheduleIdentity(previous);
  const nextIdentity = tryCronScheduleIdentity(next);
  return (
    previousIdentity !== undefined &&
    nextIdentity !== undefined &&
    previousIdentity === nextIdentity
  );
}
