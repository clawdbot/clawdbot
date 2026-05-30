import { finiteSecondsToTimerSafeMilliseconds } from "../../shared/number-coercion.js";

export function resolveCronRunTimeoutOverrideMs(timeoutSeconds: unknown): number | undefined {
  return finiteSecondsToTimerSafeMilliseconds(timeoutSeconds);
}
