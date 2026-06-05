// Voice Call plugin module implements timer delays behavior.
import { MAX_TIMER_TIMEOUT_MS, resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

// Timer delay normalization helpers for voice-call lifecycle timers.

/** Convert seconds to a safe timeout delay in milliseconds. */
export function resolveVoiceCallSecondsTimerDelayMs(seconds: number, minMs = 1): number {
  if (!Number.isFinite(seconds)) {
    return resolveTimerTimeoutMs(MAX_TIMER_TIMEOUT_MS, MAX_TIMER_TIMEOUT_MS, minMs);
  }
  const timeoutMs = Math.floor(seconds * 1000);
  return resolveTimerTimeoutMs(
    Number.isFinite(timeoutMs) ? timeoutMs : MAX_TIMER_TIMEOUT_MS,
    minMs,
    minMs,
  );
}

/** Normalize a millisecond timeout delay with fallback behavior. */
export function resolveVoiceCallTimerDelayMs(timeoutMs: number, fallbackMs = 1): number {
  return resolveTimerTimeoutMs(timeoutMs, fallbackMs);
}
