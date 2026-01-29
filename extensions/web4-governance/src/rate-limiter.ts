/**
 * Rate Limiter - Sliding window counters for policy rate limiting.
 *
 * Memory-only (no persistence). Resets on session restart.
 * Keys are derived from rule context: e.g. "ratelimit:tool:Bash"
 */

export type RateLimitResult = {
  allowed: boolean;
  current: number;
  limit: number;
};

export class RateLimiter {
  private windows: Map<string, number[]> = new Map();

  /** Check whether a key is under its rate limit. Prunes expired entries. */
  check(key: string, maxCount: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    const cutoff = now - windowMs;
    const timestamps = this.windows.get(key);

    if (!timestamps) {
      return { allowed: true, current: 0, limit: maxCount };
    }

    // Prune expired entries in-place
    const pruned = timestamps.filter((t) => t > cutoff);
    this.windows.set(key, pruned);

    return {
      allowed: pruned.length < maxCount,
      current: pruned.length,
      limit: maxCount,
    };
  }

  /** Record a new action for the given key. */
  record(key: string): void {
    const timestamps = this.windows.get(key);
    if (timestamps) {
      timestamps.push(Date.now());
    } else {
      this.windows.set(key, [Date.now()]);
    }
  }

  /** Prune all expired entries across all keys. */
  prune(windowMs: number): number {
    const now = Date.now();
    const cutoff = now - windowMs;
    let pruned = 0;

    for (const [key, timestamps] of this.windows) {
      const before = timestamps.length;
      const filtered = timestamps.filter((t) => t > cutoff);
      pruned += before - filtered.length;

      if (filtered.length === 0) {
        this.windows.delete(key);
      } else {
        this.windows.set(key, filtered);
      }
    }

    return pruned;
  }

  /** Get current count for a key (without pruning). */
  count(key: string): number {
    return this.windows.get(key)?.length ?? 0;
  }

  /** Number of tracked keys. */
  get keyCount(): number {
    return this.windows.size;
  }

  /** Build a rate limit key from rule context. */
  static key(ruleId: string, toolOrCategory: string): string {
    return `ratelimit:${ruleId}:${toolOrCategory}`;
  }
}
