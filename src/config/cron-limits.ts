// Computes cron scheduling limits from config.
import type { CronConfig } from "./types.cron.js";

/** Default maximum number of cron jobs allowed to run at once. */
export const DEFAULT_CRON_MAX_CONCURRENT_RUNS = 8;

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
