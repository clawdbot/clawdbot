import { expectDefined } from "@openclaw/normalization-core";
/** Resolves deterministic cron stagger windows for recurring schedules. */
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";
import type { CronSchedule } from "./types.js";

/** Default jitter window applied to recurring top-of-hour cron schedules. */
const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

function parseCronFields(expr: string) {
  return expr.trim().split(/\s+/).filter(Boolean);
}

const HOUR_LIST_PART = /^(?:\d+|\d+-\d+)(?:\/\d+)?$|^[*?](?:\/\d+)?$/;

function hasRecurringWildcardHour(field: string): boolean {
  const parts = field.split(",");
  return (
    parts.every((part) => HOUR_LIST_PART.test(part)) &&
    parts.some((part) => part.startsWith("*") || part.startsWith("?"))
  );
}

/** Returns whether a cron expression fires recurring jobs exactly at the top of an hour. */
function isRecurringTopOfHourCronExpr(expr: string) {
  const fields = parseCronFields(expr);
  if (fields.length === 5) {
    const [minuteField, hourField] = fields;
    return (
      minuteField === "0" &&
      hasRecurringWildcardHour(expectDefined(hourField, "stagger hour field"))
    );
  }
  if (fields.length === 6) {
    const [secondField, minuteField, hourField] = fields;
    return (
      secondField === "0" &&
      minuteField === "0" &&
      hasRecurringWildcardHour(expectDefined(hourField, "stagger hour field"))
    );
  }
  return false;
}

/** Normalizes explicit stagger values from config, preserving zero as "run exactly on schedule". */
export function normalizeCronStaggerMs(raw: unknown): number | undefined {
  const numeric =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim()
        ? (parseStrictNonNegativeInteger(raw) ?? Number.NaN)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  const normalized = Math.max(0, Math.floor(numeric));
  return Number.isSafeInteger(normalized) ? normalized : undefined;
}

/** Returns the default anti-thundering-herd stagger for top-of-hour recurring schedules. */
export function resolveDefaultCronStaggerMs(expr: string): number | undefined {
  return isRecurringTopOfHourCronExpr(expr) ? DEFAULT_TOP_OF_HOUR_STAGGER_MS : undefined;
}

/** Resolves the effective stagger for a cron schedule, preferring explicit values over defaults. */
export function resolveCronStaggerMs(schedule: Extract<CronSchedule, { kind: "cron" }>): number {
  const explicit = normalizeCronStaggerMs(schedule.staggerMs);
  if (explicit !== undefined) {
    return explicit;
  }
  const expr = (schedule as { expr?: unknown }).expr;
  const cronExpr = typeof expr === "string" ? expr : "";
  return resolveDefaultCronStaggerMs(cronExpr) ?? 0;
}
