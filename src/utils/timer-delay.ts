import { resolveSafeTimeoutDelayMs } from "../../packages/gateway-client/src/timeouts.js";

export {
  addSafeTimeoutDelayGraceMs,
  MAX_SAFE_TIMEOUT_DELAY_MS,
  resolveFiniteTimeoutDelayMs,
  resolveSafeTimeoutDelayMs,
} from "../../packages/gateway-client/src/timeouts.js";

/** Wrapper around setTimeout that clamps unsafe or invalid delays before arming the timer. */
export function setSafeTimeout(
  callback: () => void,
  delayMs: number,
  opts?: { minMs?: number },
): NodeJS.Timeout {
  return setTimeout(callback, resolveSafeTimeoutDelayMs(delayMs, opts));
}
