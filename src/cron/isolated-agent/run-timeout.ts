/** Converts cron payload timeout overrides into embedded-runner timeout signals. */
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";

/** Converts explicit cron payload timeoutSeconds into a timer-safe millisecond override signal. */
export function resolveCronRunTimeoutOverrideMs(timeoutSeconds?: number): number | undefined {
  const timeoutMs = Math.floor((timeoutSeconds ?? 0) * 1000);
  return Number.isFinite(timeoutSeconds) && timeoutMs > 0
    ? Math.min(timeoutMs, MAX_TIMER_TIMEOUT_MS)
    : undefined;
}
