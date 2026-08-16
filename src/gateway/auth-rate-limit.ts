/**
 * In-memory sliding-window rate limiter for gateway authentication attempts.
 *
 * Tracks failed auth attempts by {scope, clientIp}. A scope lets callers keep
 * independent counters for different credential classes (for example, shared
 * gateway token/password vs device-token auth) while still sharing one
 * limiter instance.
 *
 * Design decisions:
 * - Pure in-memory Map – no external dependencies; suitable for a single
 *   gateway process. The Map is periodically pruned and capped to avoid
 *   unbounded growth.
 * - Loopback addresses (127.0.0.1 / ::1) are exempt from denial by default so
 *   local CLI sessions are never locked out. Failed auth still incurs a
 *   bounded, escalating delay.
 * - The module is side-effect-free: callers create an instance via
 *   {@link createAuthRateLimiter} and pass it where needed.
 */

import {
  resolveIntegerOption,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { isLoopbackAddress, resolveClientIp } from "./net.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Maximum failed attempts before blocking.  @default 10 */
  maxAttempts?: number;
  /** Sliding window duration in milliseconds.     @default 60_000 (1 min) */
  windowMs?: number;
  /** Lockout duration in milliseconds after the limit is exceeded.  @default 300_000 (5 min) */
  lockoutMs?: number;
  /** Exempt loopback (localhost) addresses from rate limiting.  @default true */
  exemptLoopback?: boolean;
  /** Background prune interval in milliseconds; set <= 0 to disable auto-prune.  @default 60_000 */
  pruneIntervalMs?: number;
  /** Maximum tracked client identities before old unlocked entries are evicted.  @default 10_000 */
  maxEntries?: number;
}

export const AUTH_RATE_LIMIT_SCOPE_DEFAULT = "default";
export const AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET = "shared-secret";
export const AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN = "device-token";
// Per-IP gate for node-role pairing requests created during WebSocket connect.
// The request path enters the node-pairing storage lock, so bursts must be
// throttled before they queue behind that lock and delay operator actions.
export const AUTH_RATE_LIMIT_SCOPE_NODE_PAIRING = "node-pairing";
// Paired-node approval-surface changes use a dedicated limiter so reconnect
// storms cannot queue unbounded writes behind the shared pairing-state lock.
export const AUTH_RATE_LIMIT_SCOPE_NODE_REAPPROVAL = "node-reapproval";
// Per-IP gate for the pre-auth bootstrap-token verify path.
// `verifyDeviceBootstrapToken` is `withLock`-serialized in
// `device-bootstrap.ts` and runs fs read + fs write on every attempt;
// without a scope-specific limiter, attackers presenting a valid
// device signature can queue the bootstrap-pairing flow behind their
// requests, blocking legitimate node onboarding during the attack.
export const AUTH_RATE_LIMIT_SCOPE_BOOTSTRAP_TOKEN = "bootstrap-token";
// Public join-code exchange burns SQLite state, so misses are serialized and
// throttled before they can queue unbounded writes behind the shared DB lock.
export const AUTH_RATE_LIMIT_SCOPE_DEVICE_JOIN = "device-join";
// Public watchOS challenge issuance is throttled separately from credential
// failures so challenge floods cannot displace legitimate device handshakes.
export const AUTH_RATE_LIMIT_SCOPE_WATCH_CHALLENGE = "watch-challenge";
// Public worker admission verifies a high-entropy dispatch credential, but
// failures still need their own per-IP budget before store-backed retries.
export const AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION = "worker-admission";
// Workspace transfers use a separate public-ingress budget so blob requests
// cannot consume worker WebSocket admission capacity, or vice versa.
export const AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER = "worker-transfer";
export const AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH = "hook-auth";
const BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX = "browser-origin:";
const IDENTITY_RATE_LIMIT_KEY_PREFIX = "identity:";

interface RateLimitEntry {
  /** Timestamps (epoch ms) of recent failed attempts inside the window. */
  attempts: number[];
  /** If set, requests from this IP are blocked until this epoch-ms instant. */
  lockedUntil?: number;
}

export interface RateLimitCheckResult {
  /** Whether the request is allowed to proceed. */
  allowed: boolean;
  /** Number of remaining attempts before the limit is reached. */
  remaining: number;
  /** Milliseconds until the lockout expires (0 when not locked). */
  retryAfterMs: number;
}

export interface AuthRateLimiter {
  /** Check whether `ip` is currently allowed to attempt authentication. */
  check(ip: string | undefined, scope?: string): RateLimitCheckResult;
  /** Record a failed authentication attempt for `ip`. */
  recordFailure(ip: string | undefined, scope?: string): void;
  /**
   * Record a failed attempt and await any loopback penalty delay.
   *
   * Deliberately post-verification: it prices repeated guessing from one loopback
   * source without ever gating a request before its credentials are checked.
   * Gating earlier would stop parallel fan-out, but would also let a bad local
   * peer stall the operator's own correct-credential CLI, which loopback must
   * never do. Fan-out from loopback is out of scope for this limiter by design.
   */
  recordFailureAndDelay(ip: string | undefined, scope?: string): Promise<void>;
  /** Reset the rate-limit state for `ip` (e.g. after a successful login). */
  reset(ip: string | undefined, scope?: string): void;
  /** Return the current number of tracked IPs (useful for diagnostics). */
  size(): number;
  /** Remove expired entries and release memory. */
  prune(): void;
  /** Dispose the limiter and cancel periodic cleanup timers. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_LOCKOUT_MS = 300_000; // 5 minutes
const PRUNE_INTERVAL_MS = 60_000; // prune stale entries every minute
const DEFAULT_MAX_ENTRIES = 10_000;
const LOOPBACK_FAILURE_DELAY_BASE_MS = 250;
const LOOPBACK_FAILURE_DELAY_MAX_MS = 5_000;
const LOOPBACK_FAILURE_HISTORY_LIMIT =
  Math.ceil(Math.log2(LOOPBACK_FAILURE_DELAY_MAX_MS / LOOPBACK_FAILURE_DELAY_BASE_MS)) + 1;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Canonicalize client IPs used for auth throttling so all call sites
 * share one representation (including IPv4-mapped IPv6 forms).
 */
export function normalizeRateLimitClientIp(ip: string | undefined): string {
  if (
    typeof ip === "string" &&
    (ip.startsWith(BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX) ||
      ip.startsWith(IDENTITY_RATE_LIMIT_KEY_PREFIX))
  ) {
    return ip;
  }
  return resolveClientIp({ remoteAddr: ip }) ?? "unknown";
}

/** Build an opaque limiter identity that is not subject to loopback IP exemptions. */
export function buildRateLimitIdentityKey(namespace: string, identity: string): string {
  return `${IDENTITY_RATE_LIMIT_KEY_PREFIX}${namespace}:${identity}`;
}

function resolvePruneIntervalMs(value: number | undefined): number {
  if (value === undefined) {
    return PRUNE_INTERVAL_MS;
  }
  if (Number.isFinite(value) && value <= 0) {
    return 0;
  }
  return resolveTimerTimeoutMs(value, PRUNE_INTERVAL_MS);
}

export function createAuthRateLimiter(config?: RateLimitConfig): AuthRateLimiter {
  const maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const windowMs = resolveTimerTimeoutMs(config?.windowMs, DEFAULT_WINDOW_MS, 0);
  const lockoutMs = resolveTimerTimeoutMs(config?.lockoutMs, DEFAULT_LOCKOUT_MS, 0);
  const exemptLoopback = config?.exemptLoopback ?? true;
  const pruneIntervalMs = resolvePruneIntervalMs(config?.pruneIntervalMs);
  const maxEntries = resolveIntegerOption(config?.maxEntries, DEFAULT_MAX_ENTRIES, { min: 1 });

  const entries = new Map<string, RateLimitEntry>();
  // Penalty deadlines are per key, not per in-flight request: concurrent failures
  // for one key all wait out the same deadline, so an attacker cannot buy free
  // guesses by keeping timers occupied. Settlers are tracked only so dispose()
  // can release waiters without stalling gateway shutdown.
  const loopbackPenaltyUntil = new Map<string, number>();
  const loopbackPenaltyWaiters = new Map<
    string,
    { deadline: number; resolvers: (() => void)[]; timer: ReturnType<typeof setTimeout> }
  >();
  let overflowLockedUntil: number | undefined;

  // Periodic cleanup to avoid unbounded map growth.
  const pruneTimer = pruneIntervalMs > 0 ? setInterval(() => prune(), pruneIntervalMs) : null;
  // Allow the Node.js process to exit even if the timer is still active.
  if (pruneTimer?.unref) {
    pruneTimer.unref();
  }

  function normalizeScope(scope: string | undefined): string {
    return (scope ?? AUTH_RATE_LIMIT_SCOPE_DEFAULT).trim() || AUTH_RATE_LIMIT_SCOPE_DEFAULT;
  }

  function normalizeIp(ip: string | undefined): string {
    return normalizeRateLimitClientIp(ip);
  }

  function resolveKey(
    rawIp: string | undefined,
    rawScope: string | undefined,
  ): {
    key: string;
    ip: string;
  } {
    const ip = normalizeIp(rawIp);
    const scope = normalizeScope(rawScope);
    return { key: `${scope}:${ip}`, ip };
  }

  function isExempt(ip: string): boolean {
    return exemptLoopback && isLoopbackAddress(ip);
  }

  function slideWindow(entry: RateLimitEntry, now: number): void {
    const cutoff = now - windowMs;
    // Remove attempts that fell outside the window.
    entry.attempts = entry.attempts.filter((ts) => ts > cutoff);
  }

  function check(rawIp: string | undefined, rawScope?: string): RateLimitCheckResult {
    const { key, ip } = resolveKey(rawIp, rawScope);
    if (isExempt(ip)) {
      return { allowed: true, remaining: maxAttempts, retryAfterMs: 0 };
    }

    const now = Date.now();
    const entry = entries.get(key);

    if (!entry) {
      const overflowLock = checkOverflowLock(now);
      if (overflowLock) {
        return overflowLock;
      }
      return { allowed: true, remaining: maxAttempts, retryAfterMs: 0 };
    }

    // Still locked out?
    if (entry.lockedUntil && now < entry.lockedUntil) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: entry.lockedUntil - now,
      };
    }

    // Lockout expired – clear it.
    if (entry.lockedUntil && now >= entry.lockedUntil) {
      entry.lockedUntil = undefined;
      entry.attempts = [];
    }

    slideWindow(entry, now);
    const remaining = Math.max(0, maxAttempts - entry.attempts.length);
    return { allowed: remaining > 0, remaining, retryAfterMs: 0 };
  }

  function recordFailure(rawIp: string | undefined, rawScope?: string): void {
    const { key, ip } = resolveKey(rawIp, rawScope);
    const exempt = isExempt(ip);

    const now = Date.now();
    let entry = entries.get(key);

    if (!entry) {
      if (!enforceMaxEntries(now)) {
        overflowLockedUntil = Math.max(overflowLockedUntil ?? 0, now + lockoutMs);
        return;
      }
      entry = { attempts: [] };
      entries.set(key, entry);
    }

    // If currently locked, do nothing (already blocked). Loopback entries are
    // never locked, so every failed local attempt continues to count.
    if (entry.lockedUntil && now < entry.lockedUntil) {
      return;
    }

    slideWindow(entry, now);
    entry.attempts.push(now);

    if (exempt && entry.attempts.length > LOOPBACK_FAILURE_HISTORY_LIMIT) {
      // The delay is already capped at this history length. Discard older
      // timestamps so timer-cap overflow cannot grow loopback state unbounded.
      entry.attempts.splice(0, entry.attempts.length - LOOPBACK_FAILURE_HISTORY_LIMIT);
    } else if (!exempt && entry.attempts.length >= maxAttempts) {
      entry.lockedUntil = now + lockoutMs;
    }
  }

  async function recordFailureAndDelay(
    rawIp: string | undefined,
    rawScope?: string,
  ): Promise<void> {
    const { key, ip } = resolveKey(rawIp, rawScope);
    recordFailure(rawIp, rawScope);
    if (!isExempt(ip)) {
      return;
    }

    const failureCount = entries.get(key)?.attempts.length ?? 1;
    const penaltyMs = Math.min(
      LOOPBACK_FAILURE_DELAY_BASE_MS * 2 ** Math.min(failureCount - 1, 30),
      LOOPBACK_FAILURE_DELAY_MAX_MS,
    );
    // Hold the key's deadline at the furthest point any current failure earned, but
    // never past one full penalty from now, so parallel guesses cannot be answered
    // sooner than a serial one and cannot be queued into an unbounded wait either.
    const now = Date.now();
    const deadline = Math.min(
      Math.max(loopbackPenaltyUntil.get(key) ?? 0, now + penaltyMs),
      now + LOOPBACK_FAILURE_DELAY_MAX_MS,
    );
    loopbackPenaltyUntil.set(key, deadline);
    await new Promise<void>((resolve) => {
      // One timer per key, not per request: every waiter on a key is released by the
      // same deadline, so concurrent failures cost a bounded number of timers
      // (at most one per distinct loopback key) instead of one per open attempt.
      const existing = loopbackPenaltyWaiters.get(key);
      if (existing) {
        existing.resolvers.push(resolve);
        if (deadline > existing.deadline) {
          existing.deadline = deadline;
          clearTimeout(existing.timer);
          existing.timer = scheduleRelease(key, deadline);
        }
        return;
      }
      loopbackPenaltyWaiters.set(key, {
        deadline,
        resolvers: [resolve],
        timer: scheduleRelease(key, deadline),
      });
    });
  }

  function scheduleRelease(key: string, deadline: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => releaseLoopbackWaiters(key), Math.max(0, deadline - Date.now()));
    timer.unref?.();
    return timer;
  }

  function releaseLoopbackWaiters(key: string): void {
    const waiters = loopbackPenaltyWaiters.get(key);
    if (!waiters) {
      return;
    }
    loopbackPenaltyWaiters.delete(key);
    clearTimeout(waiters.timer);
    for (const resolve of waiters.resolvers) {
      resolve();
    }
  }

  function reset(rawIp: string | undefined, rawScope?: string): void {
    const { key } = resolveKey(rawIp, rawScope);
    entries.delete(key);
    loopbackPenaltyUntil.delete(key);
  }

  function pruneExpiredEntries(now: number): void {
    for (const [key, entry] of entries) {
      // If locked out, keep the entry until the lockout expires.
      if (entry.lockedUntil && now < entry.lockedUntil) {
        continue;
      }
      slideWindow(entry, now);
      if (entry.attempts.length === 0) {
        entries.delete(key);
      }
    }
    for (const [key, until] of loopbackPenaltyUntil) {
      if (now >= until) {
        loopbackPenaltyUntil.delete(key);
      }
    }
  }

  function checkOverflowLock(now: number): RateLimitCheckResult | undefined {
    if (!overflowLockedUntil) {
      return undefined;
    }
    if (now >= overflowLockedUntil) {
      overflowLockedUntil = undefined;
      return undefined;
    }
    if (entries.size >= maxEntries) {
      pruneExpiredEntries(now);
    }
    if (entries.size < maxEntries) {
      overflowLockedUntil = undefined;
      return undefined;
    }
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: overflowLockedUntil - now,
    };
  }

  function enforceMaxEntries(now: number): boolean {
    if (entries.size < maxEntries) {
      return true;
    }

    pruneExpiredEntries(now);
    if (entries.size < maxEntries) {
      return true;
    }

    // Preserve active lockouts so a flood cannot evict the attacker's own block.
    for (const [entryKey, entry] of entries) {
      if (!entry.lockedUntil || now >= entry.lockedUntil) {
        entries.delete(entryKey);
        return true;
      }
    }
    return false;
  }

  function prune(): void {
    pruneExpiredEntries(Date.now());
  }

  function size(): number {
    return entries.size;
  }

  function dispose(): void {
    if (pruneTimer) {
      clearInterval(pruneTimer);
    }
    entries.clear();
    loopbackPenaltyUntil.clear();
    overflowLockedUntil = undefined;
    for (const key of loopbackPenaltyWaiters.keys()) {
      releaseLoopbackWaiters(key);
    }
  }

  return { check, recordFailure, recordFailureAndDelay, reset, size, prune, dispose };
}
