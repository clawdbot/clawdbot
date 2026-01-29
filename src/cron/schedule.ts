import { Cron } from "croner";
import type { CronSchedule } from "./types.js";

export type ComputeNextRunOpts = {
  /** Default timezone to use when schedule.tz is not specified. */
  defaultTimezone?: string;
};

export function computeNextRunAtMs(
  schedule: CronSchedule,
  nowMs: number,
  opts?: ComputeNextRunOpts,
): number | undefined {
  if (schedule.kind === "at") {
    return schedule.atMs > nowMs ? schedule.atMs : undefined;
  }

  if (schedule.kind === "every") {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs));
    const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));
    if (nowMs < anchor) return anchor;
    const elapsed = nowMs - anchor;
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
    return anchor + steps * everyMs;
  }

  const expr = schedule.expr.trim();
  if (!expr) return undefined;
  // Use schedule.tz if specified, otherwise fall back to default timezone
  const timezone = schedule.tz?.trim() || opts?.defaultTimezone?.trim() || undefined;
  const cron = new Cron(expr, {
    timezone,
    catch: false,
  });
  const next = cron.nextRun(new Date(nowMs));
  return next ? next.getTime() : undefined;
}
