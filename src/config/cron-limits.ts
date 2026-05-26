import type { CronConfig } from "./types.cron.js";

export const DEFAULT_CRON_MAX_CONCURRENT_RUNS = 8;

export function resolveCronMaxConcurrentRuns(
  cronConfig?: Pick<CronConfig, "maxConcurrentRuns">,
): number {
  const raw = cronConfig?.maxConcurrentRuns;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_CRON_MAX_CONCURRENT_RUNS;
}
