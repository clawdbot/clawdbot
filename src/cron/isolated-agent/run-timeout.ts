import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";

/** Converts explicit cron payload timeoutSeconds into a timer-safe millisecond override signal. */
export function resolveCronRunTimeoutOverrideMs(timeoutSeconds: unknown): number | undefined {
  return finiteSecondsToTimerSafeMilliseconds(timeoutSeconds);
}
