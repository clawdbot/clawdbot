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
      const ms = parseDurationMs(raw.trim(), { defaultUnit: "h" });
      // A zero retention ("0h") is a disable signal, not "prune everything":
      // cutoff would equal now and the next sweep would delete every cron run
      // session. Negative durations never get here (the parser rejects them);
      // the <= 0 check stays defensive.
      if (ms <= 0) {
        return null;
      }
      return ms;
    } catch {
      return DEFAULT_CRON_SESSION_RETENTION_MS;
    }
  }
  return DEFAULT_CRON_SESSION_RETENTION_MS;
}
