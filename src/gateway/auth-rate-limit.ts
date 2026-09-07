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
import type { GatewayAuthRateLimitConfig } from "../config/types.gateway.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { isLoopbackAddress, resolveClientIp } from "./net.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitConfig extends GatewayAuthRateLimitConfig {
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

const authRateLimiterExemptionChecks = new WeakMap<
  AuthRateLimiter,
  (ip: string | undefined) => boolean
>();

/** Whether a limiter created by this module exempts the prepared client identity. */
export function isAuthRateLimitClientExempt(
  limiter: AuthRateLimiter,
  ip: string | undefined,
): boolean {
  return authRateLimiterExemptionChecks.get(limiter)?.(ip) ?? false;
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

function resolveAuthRateLimitPolicy(config?: GatewayAuthRateLimitConfig) {
  return {
    maxAttempts: config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    windowMs: resolveTimerTimeoutMs(config?.windowMs, DEFAULT_WINDOW_MS, 0),
    lockoutMs: resolveTimerTimeoutMs(config?.lockoutMs, DEFAULT_LOCKOUT_MS, 0),
    exemptLoopback: config?.exemptLoopback ?? true,
  };
}

export function createAuthRateLimiter(config?: RateLimitConfig): AuthRateLimiter & {
  updateConfig: (config?: GatewayAuthRateLimitConfig) => void;
} {
  let policy = resolveAuthRateLimitPolicy(config);
  const pruneIntervalMs = resolvePruneIntervalMs(config?.pruneIntervalMs);
  const maxEntries = resolveIntegerOption(config?.maxEntries, DEFAULT_MAX_ENTRIES, { min: 1 });

  const entries = new Map<string, RateLimitEntry>();
  // One promise and timer per key preserve earned delays across concurrent
  // failures and history resets; dispose releases them for Gateway shutdown.
  const loopbackPenaltyWaiters = new Map<
    string,
    Deferred & { deadline: number; timer: ReturnType<typeof setTimeout> }
  >();
  let overflowLockedUntil: number | undefined;

  // Periodic cleanup to avoid unbounded map growth.
  const pruneTimer = pruneIntervalMs > 0 ? setInterval(() => prune(), pruneIntervalMs) : null;
  // Allow the Node.js process to exit even if the timer is still active.
  if (pruneTimer?.unref) {
    pruneTimer.unref();
  }

  function resolveKey(
    rawIp: string | undefined,
    rawScope: string | undefined,
  ): {
    key: string;
    ip: string;
  } {
    const ip = normalizeRateLimitClientIp(rawIp);
    const scope = rawScope?.trim() || AUTH_RATE_LIMIT_SCOPE_DEFAULT;
    return { key: `${scope}:${ip}`, ip };
  }

  function isExempt(ip: string): boolean {
    return policy.exemptLoopback && isLoopbackAddress(ip);
  }

  function refreshEntry(entry: RateLimitEntry, now: number): void {
    // Retire served lockout history before recording fresh failures; a later
    // check must not erase attempts accepted after the old deadline.
    if (entry.lockedUntil && now >= entry.lockedUntil) {
      entry.lockedUntil = undefined;
      entry.attempts = [];
    }
    const cutoff = now - policy.windowMs;
    entry.attempts = entry.attempts.filter((ts) => ts > cutoff);
  }

  function check(rawIp: string | undefined, rawScope?: string): RateLimitCheckResult {
    const { key, ip } = resolveKey(rawIp, rawScope);
    if (isExempt(ip)) {
      return { allowed: true, remaining: policy.maxAttempts, retryAfterMs: 0 };
    }

    const now = Date.now();
    const entry = entries.get(key);

    if (!entry) {
      const overflowLock = checkOverflowLock(now);
      if (overflowLock) {
        return overflowLock;
      }
      return { allowed: true, remaining: policy.maxAttempts, retryAfterMs: 0 };
    }

    refreshEntry(entry, now);
    // A tighter live limit applies to retained failures without resetting an
    // already-earned lockout or waiting for another credential attempt.
    if (!entry.lockedUntil && entry.attempts.length >= policy.maxAttempts) {
      entry.lockedUntil = now + policy.lockoutMs;
    }
    if (entry.lockedUntil && now < entry.lockedUntil) {
      return { allowed: false, remaining: 0, retryAfterMs: entry.lockedUntil - now };
    }
    const remaining = Math.max(0, policy.maxAttempts - entry.attempts.length);
    return { allowed: remaining > 0, remaining, retryAfterMs: 0 };
  }

  function recordFailure(rawIp: string | undefined, rawScope?: string): void {
    const { key, ip } = resolveKey(rawIp, rawScope);
    const exempt = isExempt(ip);

    const now = Date.now();
    let entry = entries.get(key);

    if (!entry) {
      if (!enforceMaxEntries(now)) {
        overflowLockedUntil = Math.max(overflowLockedUntil ?? 0, now + policy.lockoutMs);
        return;
      }
      entry = { attempts: [] };
      entries.set(key, entry);
    }

    // A new loopback exemption resumes penalty counting without extending or
    // discarding the lockout earned before that policy change.
    if (!exempt && entry.lockedUntil && now < entry.lockedUntil) {
      return;
    }

    refreshEntry(entry, now);
    entry.attempts.push(now);

    if (exempt && entry.attempts.length > LOOPBACK_FAILURE_HISTORY_LIMIT) {
      // The delay is already capped at this history length. Discard older
      // timestamps so timer-cap overflow cannot grow loopback state unbounded.
      entry.attempts.splice(0, entry.attempts.length - LOOPBACK_FAILURE_HISTORY_LIMIT);
    } else if (!exempt && entry.attempts.length >= policy.maxAttempts) {
      entry.lockedUntil = now + policy.lockoutMs;
    }
  }

  function recordFailureAndDelay(rawIp: string | undefined, rawScope?: string): Promise<void> {
    const { key, ip } = resolveKey(rawIp, rawScope);
    recordFailure(rawIp, rawScope);
    if (!isExempt(ip)) {
      return Promise.resolve();
    }

    const failureCount = entries.get(key)?.attempts.length ?? 1;
    const penaltyMs = Math.min(
      LOOPBACK_FAILURE_DELAY_BASE_MS * 2 ** Math.min(failureCount - 1, 30),
      LOOPBACK_FAILURE_DELAY_MAX_MS,
    );
    const deadline = Date.now() + penaltyMs;
    let waiters = loopbackPenaltyWaiters.get(key);
    if (!waiters) {
      waiters = {
        ...createDeferredCore(),
        deadline,
        timer: scheduleRelease(key, deadline),
      };
      loopbackPenaltyWaiters.set(key, waiters);
    } else if (deadline > waiters.deadline) {
      waiters.deadline = deadline;
      clearTimeout(waiters.timer);
      waiters.timer = scheduleRelease(key, deadline);
    }
    return waiters.promise;
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
    waiters.resolve();
  }

  function reset(rawIp: string | undefined, rawScope?: string): void {
    const { key } = resolveKey(rawIp, rawScope);
    entries.delete(key);
  }

  function pruneExpiredEntries(now: number): void {
    for (const [key, entry] of entries) {
      // If locked out, keep the entry until the lockout expires.
      if (entry.lockedUntil && now < entry.lockedUntil) {
        continue;
      }
      refreshEntry(entry, now);
      if (entry.attempts.length === 0) {
        entries.delete(key);
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
    overflowLockedUntil = undefined;
    for (const key of loopbackPenaltyWaiters.keys()) {
      releaseLoopbackWaiters(key);
    }
  }

  const limiter = {
    check,
    recordFailure,
    recordFailureAndDelay,
    reset,
    size,
    prune,
    dispose,
    updateConfig: (next?: GatewayAuthRateLimitConfig) => {
      policy = resolveAuthRateLimitPolicy(next);
    },
  };
  // Credential-fallback owners use the exact limiter policy to avoid holding
  // exempt loopback penalty delays inside a per-identity serialization queue.
  authRateLimiterExemptionChecks.set(limiter, (rawIp) =>
    isExempt(normalizeRateLimitClientIp(rawIp)),
  );
  return limiter;
}
