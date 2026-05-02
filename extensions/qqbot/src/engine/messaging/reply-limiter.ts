/**
 * Passive reply limiter — enforce per-message reply count and TTL limits.
 *
 * QQ Bot restricts how many passive replies can be sent in response to a
 * single inbound message (4 per hour by default). This module tracks reply
 * counts and determines whether the next reply should be passive or
 * fall back to proactive mode.
 *
 * The module is a **class** with zero I/O dependencies, fully supporting
 * multi-account concurrent operation via separate instances.
 */

/** Configuration for the reply limiter. */
interface ReplyLimiterConfig {
  /** Maximum passive replies per message. Defaults to 4. */
  limit?: number;
  /** TTL in milliseconds for the passive reply window. Defaults to 1 hour. */
  ttlMs?: number;
  /** Maximum number of tracked messages before eviction. Defaults to 10000. */
  maxTrackedMessages?: number;
}

/** Result of a passive-reply limit check. */
export interface ReplyLimitResult {
  /** Whether a passive reply is still allowed. */
  allowed: boolean;
  /** Number of remaining passive replies. */
  remaining: number;
  /** Whether the caller should fall back to proactive mode. */
  shouldFallbackToProactive: boolean;
  /** Reason for the fallback. */
  fallbackReason?: "expired" | "limit_exceeded";
  /** Human-readable diagnostic message. */
  message?: string;
}

interface ReplyRecord {
  count: number;
  firstReplyAt: number;
}

const DEFAULT_LIMIT = 4;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_TRACKED = 10_000;

/**
 * Per-account reply limiter with automatic eviction.
 *
 * Usage:
 * ```ts
 * const limiter = new ReplyLimiter({ limit: 4, ttlMs: 3600000 });
 * const check = limiter.checkLimit(messageId);
 * if (check.allowed) {
 *   await sendPassiveReply(...);
 *   limiter.record(messageId);
 * } else if (check.shouldFallbackToProactive) {
 *   await sendProactiveMessage(...);
 * }
 * ```
 */
export class ReplyLimiter {
  private readonly limit: number;
  private readonly ttlMs: number;
  private readonly maxTracked: number;
  private readonly tracker = new Map<string, ReplyRecord>();

  constructor(config?: ReplyLimiterConfig) {
    this.limit = config?.limit ?? DEFAULT_LIMIT;
    this.ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxTracked = config?.maxTrackedMessages ?? DEFAULT_MAX_TRACKED;
  }

  /** Check whether a passive reply is allowed for the given message. */
  checkLimit(messageId: string): ReplyLimitResult {
    const now = Date.now();
    this.evictIfNeeded(now);

    const record = this.tracker.get(messageId);

    if (!record) {
      return {
        allowed: true,
        remaining: this.limit,
        shouldFallbackToProactive: false,
      };
    }

    if (now - record.firstReplyAt > this.ttlMs) {
      return {
        allowed: false,
        remaining: 0,
        shouldFallbackToProactive: true,
        fallbackReason: "expired",
        message: `Message is older than ${this.ttlMs / (60 * 60 * 1000)}h; sending as a proactive message instead`,
      };
    }

    const remaining = this.limit - record.count;
    if (remaining <= 0) {
      return {
        allowed: false,
        remaining: 0,
        shouldFallbackToProactive: true,
        fallbackReason: "limit_exceeded",
        message: `Passive reply limit reached (${this.limit} per hour); sending proactively instead`,
      };
    }

    return {
      allowed: true,
      remaining,
      shouldFallbackToProactive: false,
    };
  }

  /** Record one passive reply against a message. */
  record(messageId: string): void {
    const now = Date.now();
    const existing = this.tracker.get(messageId);

    if (!existing) {
      this.tracker.set(messageId, { count: 1, firstReplyAt: now });
    } else if (now - existing.firstReplyAt > this.ttlMs) {
      this.tracker.set(messageId, { count: 1, firstReplyAt: now });
    } else {
      existing.count++;
    }
  }

  /** Return diagnostic stats. */
  getStats(): { trackedMessages: number; totalReplies: number } {
    let totalReplies = 0;
    for (const record of this.tracker.values()) {
      totalReplies += record.count;
    }
    return { trackedMessages: this.tracker.size, totalReplies };
  }

  /** Return limiter configuration. */
  getConfig(): { limit: number; ttlMs: number; ttlHours: number } {
    return {
      limit: this.limit,
      ttlMs: this.ttlMs,
      ttlHours: this.ttlMs / (60 * 60 * 1000),
    };
  }

  /** Clear all tracked records. */
  clear(): void {
    this.tracker.clear();
  }

  /** Opportunistically evict expired records to keep the tracker bounded. */
  private evictIfNeeded(now: number): void {
    if (this.tracker.size <= this.maxTracked) {
      return;
    }
    for (const [id, rec] of this.tracker) {
      if (now - rec.firstReplyAt > this.ttlMs) {
        this.tracker.delete(id);
      }
    }
  }
}
