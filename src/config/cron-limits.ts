// Computes cron scheduling limits from config.
import type { CronConfig } from "./types.cron.js";

/** Default maximum number of cron jobs allowed to run at once. */
export const DEFAULT_CRON_MAX_CONCURRENT_RUNS = 8;
const DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS = 30_000;

/** Resolves cron concurrency config, flooring finite values and clamping to at least one. */
export function resolveCronMaxConcurrentRuns(
  cronConfig?: Pick<CronConfig, "maxConcurrentRuns">,
): number {
  const raw = cronConfig?.maxConcurrentRuns;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_CRON_MAX_CONCURRENT_RUNS;
}

/** Resolves the minimum cadence for trigger-bearing cron jobs. */
export function resolveCronTriggerMinIntervalMs(cronConfig?: Pick<CronConfig, "triggers">): number {
  const raw = cronConfig?.triggers?.minIntervalMs;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS;
}
