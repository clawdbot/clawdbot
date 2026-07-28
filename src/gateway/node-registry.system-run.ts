import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

/** Normalize system.run timeout values, preserving null for no expiry. */
export function normalizeSystemRunTimeoutMs(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const timeoutMs = Math.trunc(value);
  return timeoutMs > 0 ? resolveTimerTimeoutMs(timeoutMs, 1) : null;
}
