/** Builds stable identities for cron scheduling inputs. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseCronPacingBounds } from "./pacing.js";
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

function schedulePayloadFromRecord(schedule: Record<string, unknown>):
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | { kind: "on-exit"; command: string; cwd?: string }
  | {
      kind: "stream";
      command: string[];
      cwd?: string;
      mode?: "line" | "match";
      match?: string;
      batchMs?: number;
      maxBatchBytes?: number;
    }
  | undefined {
  const rawKind = readString(schedule, "kind")?.toLowerCase();
  const expr = readString(schedule, "expr");
  const at = readString(schedule, "at");
  const everyMs = readNumber(schedule, "everyMs");
  const anchorMs = readNumber(schedule, "anchorMs");
  const tz = readString(schedule, "tz");
  const staggerMs = readStaggerMs(schedule);
  const kind =
    // Infer legacy shorthand schedule shapes when kind is missing so timer
    // identity remains stable across old persisted jobs and normalized jobs.
    rawKind === "at" ||
    rawKind === "every" ||
    rawKind === "cron" ||
    rawKind === "on-exit" ||
    rawKind === "stream"
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
  if (kind === "on-exit") {
    const command = readString(schedule, "command");
    return command ? { kind: "on-exit", command, cwd: readString(schedule, "cwd") } : undefined;
  }
  if (kind === "stream") {
    const command = schedule.command;
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.some((entry) => typeof entry !== "string" || entry.length === 0)
    ) {
      return undefined;
    }
    const mode = readString(schedule, "mode");
    return {
      kind: "stream",
      command: [...command],
      cwd: readString(schedule, "cwd"),
      mode: mode === "line" || mode === "match" ? mode : undefined,
      match: typeof schedule.match === "string" ? schedule.match : undefined,
      batchMs: readNumber(schedule, "batchMs"),
      maxBatchBytes: readNumber(schedule, "maxBatchBytes"),
    };
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

function resolvePacingPayload(
  job: CronScheduleIdentityInput,
): { minMs?: number; maxMs?: number } | null | undefined {
  if (job.pacing === undefined || job.pacing === null) {
    return undefined;
  }
  if (typeof job.pacing !== "object" || Array.isArray(job.pacing)) {
    return null;
  }
  const pacing = job.pacing as Record<string, unknown>;
  const min = normalizeOptionalString(pacing.min);
  const max = normalizeOptionalString(pacing.max);
  try {
    return parseCronPacingBounds({ min, max });
  } catch {
    return null;
  }
}

/** Builds a stable scheduling identity for deciding whether stored timer state is still valid. */
export function tryCronScheduleIdentity(job: CronScheduleIdentityInput): string | undefined {
  const schedule = resolveSchedulePayload(job);
  const pacing = resolvePacingPayload(job);
  if (!schedule || pacing === null) {
    return undefined;
  }
  return JSON.stringify({
    version: 2,
    enabled: typeof job.enabled === "boolean" ? job.enabled : true,
    schedule,
    pacing,
    hasTrigger: job.trigger !== undefined && job.trigger !== null,
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
