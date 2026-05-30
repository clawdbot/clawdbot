import {
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
  MAX_TIMER_TIMEOUT_MS,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";

export function resolveQaGatewayTimeoutWithGraceMs(
  timeoutMs: unknown,
  graceMs: unknown = 5_000,
): number | undefined {
  const timeout = clampPositiveTimerTimeoutMs(timeoutMs);
  if (timeout === undefined) {
    return undefined;
  }
  if (timeout >= MAX_TIMER_TIMEOUT_MS) {
    return MAX_TIMER_TIMEOUT_MS;
  }
  const grace = resolveTimerTimeoutMs(graceMs, 0, 0);
  return addTimerTimeoutGraceMs(timeout, grace);
}
