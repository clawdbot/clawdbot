/**
 * Runtime auth refresh timer helper.
 *
 * Clamps refresh deadlines before they are passed to setTimeout.
 */
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";

// Timer helper for runtime auth refresh scheduling.
/** Clamp an auth refresh deadline to a safe setTimeout delay. */
export function clampRuntimeAuthRefreshDelayMs(params: {
  refreshAt: number;
  now: number;
  minDelayMs: number;
}): number {
  return resolveSafeTimeoutDelayMs(params.refreshAt - params.now, { minMs: params.minDelayMs });
}
