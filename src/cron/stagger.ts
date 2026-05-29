import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";
import type { CronSchedule } from "./types.js";

export const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

function parseCronFields(expr: string) {
  return expr.trim().split(/\s+/).filter(Boolean);
}

export function isRecurringTopOfHourCronExpr(expr: string) {
  const fields = parseCronFields(expr);
  if (fields.length === 5) {
    const [minuteField, hourField] = fields;
    return minuteField === "0" && hourField.includes("*");
  }
  if (fields.length === 6) {
    const [secondField, minuteField, hourField] = fields;
    return secondField === "0" && minuteField === "0" && hourField.includes("*");
  }
  return false;
}

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
  return Math.max(0, Math.floor(numeric));
}

export function resolveDefaultCronStaggerMs(expr: string): number | undefined {
  return isRecurringTopOfHourCronExpr(expr) ? DEFAULT_TOP_OF_HOUR_STAGGER_MS : undefined;
}

export function resolveCronStaggerMs(schedule: Extract<CronSchedule, { kind: "cron" }>): number {
  const explicit = normalizeCronStaggerMs(schedule.staggerMs);
  if (explicit !== undefined) {
    return explicit;
  }
  const expr = (schedule as { expr?: unknown }).expr;
  const cronExpr = typeof expr === "string" ? expr : "";
  return resolveDefaultCronStaggerMs(cronExpr) ?? 0;
}
