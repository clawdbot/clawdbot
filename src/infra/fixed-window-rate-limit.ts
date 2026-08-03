/**
 * Shared fixed-window rate-limit primitive for gateway, ACP, and webhook ingress.
 *
 * It is intentionally in-memory and process-local; callers that need distributed
 * limits must layer their own persistence before invoking request work.
 */

/** Minimal fixed-window limiter interface used by memory and request guard helpers. */
export type FixedWindowRateLimiter = {
  consume: () => {
    /** Whether the current call consumed quota successfully. */
    allowed: boolean;
    /** Milliseconds until the next fixed window when quota is exhausted. */
    retryAfterMs: number;
    /** Requests left in the current window after this consume call. */
    remaining: number;
  };
  /** Clears the current fixed-window count and starts fresh on the next consume call. */
  reset: () => void;
};

/** Normalizes rate-limit numeric config to a finite integer with a lower bound. */
export function resolveFixedWindowRateLimitInteger(
  value: number | undefined,
  fallback: number,
  params: { min: number },
): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(params.min, Math.floor(candidate));
}

/** Creates a fixed-window counter that reports allowance, remaining quota, and retry delay. */
export function createFixedWindowRateLimiter(params: {
  /** Maximum successful consume calls allowed per window. */
  maxRequests: number;
  /** Fixed window duration in milliseconds. */
  windowMs: number;
  /** Optional clock for tests or deterministic host runtimes. */
  now?: () => number;
}): FixedWindowRateLimiter {
  const maxRequests = resolveFixedWindowRateLimitInteger(params.maxRequests, 1, { min: 1 });
  const windowMs = resolveFixedWindowRateLimitInteger(params.windowMs, 1, { min: 1 });
  const now = params.now ?? Date.now;

  let count = 0;
  let windowStartMs = 0;

  return {
    consume() {
      const nowMs = now();
      if (nowMs - windowStartMs >= windowMs) {
        // Fixed-window semantics reset all quota at the first request after the window expires.
        windowStartMs = nowMs;
        count = 0;
      }
      if (count >= maxRequests) {
        // Clamp retryAfterMs for injected clocks that move unexpectedly between consume calls.
        return {
          allowed: false,
          retryAfterMs: Math.max(0, windowStartMs + windowMs - nowMs),
          remaining: 0,
        };
      }
      count += 1;
      return {
        allowed: true,
        retryAfterMs: 0,
        remaining: Math.max(0, maxRequests - count),
      };
    },
    reset() {
      count = 0;
      windowStartMs = 0;
    },
  };
}
