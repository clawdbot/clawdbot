import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";

export function resolveCronRunTimeoutOverrideMs(timeoutSeconds: unknown): number | undefined {
  return finiteSecondsToTimerSafeMilliseconds(timeoutSeconds);
}
