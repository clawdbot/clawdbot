/**
 * Simple token bucket rate limiter for message handlers.
 * Limits execution to prevent cost explosions from unbounded agent execution.
 */

const DEFAULT_RATE_LIMIT = 10; // 10 executions per minute per handler
const DEFAULT_WINDOW_MS = 60_000; // 1 minute window

type HandlerBucket = {
  tokens: number;
  lastRefill: number;
};

const buckets = new Map<string, HandlerBucket>();

/**
 * Check if a handler is rate limited.
 * Returns true if the handler should be blocked (rate limited).
 * Returns false and consumes a token if the handler can proceed.
 *
 * @param handlerId - Unique identifier for the handler
 * @param rateLimit - Max executions per window (default: 10)
 * @param windowMs - Window duration in ms (default: 60000)
 * @returns true if rate limited (should skip), false if allowed
 */
export function isHandlerRateLimited(
  handlerId: string,
  rateLimit: number = DEFAULT_RATE_LIMIT,
  windowMs: number = DEFAULT_WINDOW_MS,
): boolean {
  const now = Date.now();
  let bucket = buckets.get(handlerId);

  if (!bucket) {
    bucket = { tokens: rateLimit, lastRefill: now };
    buckets.set(handlerId, bucket);
  }

  // Refill tokens based on time elapsed
  const elapsed = now - bucket.lastRefill;
  if (elapsed >= windowMs) {
    bucket.tokens = rateLimit;
    bucket.lastRefill = now;
  }

  // Check if we have tokens
  if (bucket.tokens <= 0) {
    return true; // Rate limited
  }

  // Consume a token
  bucket.tokens -= 1;
  return false; // Not rate limited
}

/**
 * Get rate limit info for a handler (for debugging/monitoring).
 *
 * @param handlerId - Unique identifier for the handler
 * @returns Current rate limit state or null if no bucket exists
 */
export function getHandlerRateLimitInfo(
  handlerId: string,
): { remaining: number; resetMs: number } | null {
  const bucket = buckets.get(handlerId);
  if (!bucket) return null;
  return {
    remaining: bucket.tokens,
    resetMs: DEFAULT_WINDOW_MS - (Date.now() - bucket.lastRefill),
  };
}

/**
 * Reset rate limit for a handler (for testing).
 *
 * @param handlerId - Unique identifier for the handler
 */
export function resetHandlerRateLimit(handlerId: string): void {
  buckets.delete(handlerId);
}

/**
 * Reset all rate limits (for testing).
 */
export function resetAllRateLimits(): void {
  buckets.clear();
}
