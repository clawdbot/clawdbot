import { parseDurationMs } from "../cli/parse-duration.js";
import type { CronConfig } from "../config/types.cron.js";

const DEFAULT_CRON_SESSION_RETENTION_MS = 24 * 3_600_000;

/** Resolves cron run-session retention; `false` disables pruning, bad strings fall back safely. */
export function resolveCronSessionRetentionMs(
  cronConfig?: Pick<CronConfig, "sessionRetention">,
): number | null {
  if (cronConfig?.sessionRetention === false) {
    return null;
  }
  const raw = cronConfig?.sessionRetention;
  if (typeof raw === "string" && raw.trim()) {
    try {
      return parseDurationMs(raw.trim(), { defaultUnit: "h" });
    } catch {
      return DEFAULT_CRON_SESSION_RETENTION_MS;
    }
  }
  return DEFAULT_CRON_SESSION_RETENTION_MS;
}
