import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  createAuthRateLimiter,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";

describe("auth rate limiter", () => {
  let limiter: AuthRateLimiter;
  const baseConfig = { maxAttempts: 2, windowMs: 60_000, lockoutMs: 60_000 };

  function createLimiter(
    overrides?: Partial<{
      maxAttempts: number;
      windowMs: number;
      lockoutMs: number;
      exemptLoopback: boolean;
      pruneIntervalMs: number;
    }>,
  ) {
    limiter = createAuthRateLimiter({
      ...baseConfig,
      ...overrides,
    });
    return limiter;
  }

  afterEach(() => {
    limiter?.dispose();
  });

  // ---------- basic sliding window ----------

  it("allows requests when no failures have been recorded", () => {
    limiter = createAuthRateLimiter({ maxAttempts: 5, windowMs: 60_000, lockoutMs: 300_000 });
    const result = limiter.check("192.168.1.1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);
    expect(result.retryAfterMs).toBe(0);
  });

  it("decrements remaining count after each failure", () => {
    limiter = createAuthRateLimiter({ maxAttempts: 3, windowMs: 60_000, lockoutMs: 300_000 });
    limiter.recordFailure("10.0.0.1");
    expect(limiter.check("10.0.0.1").remaining).toBe(2);
    limiter.recordFailure("10.0.0.1");
    expect(limiter.check("10.0.0.1").remaining).toBe(1);
  });

  it("blocks the IP once maxAttempts is reached", () => {
    createLimiter({ lockoutMs: 10_000 });
    limiter.recordFailure("10.0.0.2");
    limiter.recordFailure("10.0.0.2");
    const result = limiter.check("10.0.0.2");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(10_000);
  });

  it("treats blank scopes as the default scope", () => {
    createLimiter();
    limiter.recordFailure("10.0.0.8", "   ");
    limiter.recordFailure("10.0.0.8");
    expect(limiter.check("10.0.0.8").allowed).toBe(false);
    expect(limiter.check("10.0.0.8", " \t ").allowed).toBe(false);
  });

  // ---------- lockout expiry ----------

  it("unblocks after the lockout period expires", () => {
    vi.useFakeTimers();
    try {
      createLimiter({ lockoutMs: 5_000 });
      limiter.recordFailure("10.0.0.3");
      limiter.recordFailure("10.0.0.3");
      expect(limiter.check("10.0.0.3").allowed).toBe(false);

      // Advance just past the lockout.
      vi.advanceTimersByTime(5_001);
      const result = limiter.check("10.0.0.3");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not extend lockout when failures are recorded while already locked", () => {
    vi.useFakeTimers();
    try {
      createLimiter({ lockoutMs: 5_000 });
      limiter.recordFailure("10.0.0.33");
      limiter.recordFailure("10.0.0.33");
      const locked = limiter.check("10.0.0.33");
      expect(locked.allowed).toBe(false);
      const initialRetryAfter = locked.retryAfterMs;

      vi.advanceTimersByTime(1_000);
      limiter.recordFailure("10.0.0.33");
      const afterExtraFailure = limiter.check("10.0.0.33");
      expect(afterExtraFailure.retryAfterMs).toBeLessThanOrEqual(initialRetryAfter - 1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps oversized lockout durations", () => {
    vi.useFakeTimers();
    try {
      limiter = createAuthRateLimiter({
        maxAttempts: 1,
        windowMs: 60_000,
        lockoutMs: Number.MAX_SAFE_INTEGER,
      });

      limiter.recordFailure("10.0.0.34");

      expect(limiter.check("10.0.0.34").retryAfterMs).toBe(MAX_TIMER_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------- sliding window expiry ----------

  it("expires old failures outside the window", () => {
    vi.useFakeTimers();
    try {
      limiter = createAuthRateLimiter({ maxAttempts: 3, windowMs: 10_000, lockoutMs: 60_000 });
      limiter.recordFailure("10.0.0.4");
      limiter.recordFailure("10.0.0.4");
      expect(limiter.check("10.0.0.4").remaining).toBe(1);

      // Move past the window so the two old failures expire.
      vi.advanceTimersByTime(11_000);
      expect(limiter.check("10.0.0.4").remaining).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------- per-IP isolation ----------

  it("tracks IPs independently", () => {
    createLimiter();
    limiter.recordFailure("10.0.0.10");
    limiter.recordFailure("10.0.0.10");
    expect(limiter.check("10.0.0.10").allowed).toBe(false);

    // A different IP should be unaffected.
    expect(limiter.check("10.0.0.11").allowed).toBe(true);
    expect(limiter.check("10.0.0.11").remaining).toBe(2);
  });

  it("treats ipv4 and ipv4-mapped ipv6 forms as the same client", () => {
    limiter = createAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    limiter.recordFailure("1.2.3.4");
    expect(limiter.check("::ffff:1.2.3.4").allowed).toBe(false);
  });

  it.each([AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH])(
    "tracks %s independently from shared-secret for the same IP",
    (otherScope) => {
      limiter = createAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
      limiter.recordFailure("10.0.0.12", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
      expect(limiter.check("10.0.0.12", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET).allowed).toBe(false);
      expect(limiter.check("10.0.0.12", otherScope).allowed).toBe(true);
    },
  );

  it("tracks synthetic browser-origin limiter keys independently", () => {
    limiter = createAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    limiter.recordFailure("browser-origin:http://127.0.0.1:18789");
    expect(limiter.check("browser-origin:http://127.0.0.1:18789").allowed).toBe(false);
    expect(limiter.check("browser-origin:http://localhost:5173").allowed).toBe(true);
  });

  // ---------- loopback exemption ----------

  it.each(["127.0.0.1", "::1"])("exempts loopback address %s by default", (ip) => {
    limiter = createAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    limiter.recordFailure(ip);
    expect(limiter.check(ip).allowed).toBe(true);
  });

  it("rate-limits loopback when exemptLoopback is false", () => {
    limiter = createAuthRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      exemptLoopback: false,
    });
    limiter.recordFailure("127.0.0.1");
    expect(limiter.check("127.0.0.1").allowed).toBe(false);
  });

  // ---------- reset ----------

  it("clears tracking state when reset is called", () => {
    createLimiter();
    limiter.recordFailure("10.0.0.20");
    limiter.recordFailure("10.0.0.20");
    expect(limiter.check("10.0.0.20").allowed).toBe(false);

    limiter.reset("10.0.0.20");
    expect(limiter.check("10.0.0.20").allowed).toBe(true);
    expect(limiter.check("10.0.0.20").remaining).toBe(2);
  });

  it("reset only clears the requested scope for an IP", () => {
    limiter = createAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    limiter.recordFailure("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
    limiter.recordFailure("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
    expect(limiter.check("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET).allowed).toBe(false);
    expect(limiter.check("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).allowed).toBe(false);

    limiter.reset("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
    expect(limiter.check("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET).allowed).toBe(true);
    expect(limiter.check("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).allowed).toBe(false);
  });

  // ---------- prune ----------

  it("prune removes stale entries", () => {
    vi.useFakeTimers();
    try {
      limiter = createAuthRateLimiter({ maxAttempts: 5, windowMs: 5_000, lockoutMs: 5_000 });
      limiter.recordFailure("10.0.0.30");
      expect(limiter.size()).toBe(1);

      vi.advanceTimersByTime(6_000);
      limiter.prune();
      expect(limiter.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prune keeps entries that are still locked out", () => {
    vi.useFakeTimers();
    try {
      limiter = createAuthRateLimiter({ maxAttempts: 1, windowMs: 5_000, lockoutMs: 30_000 });
      limiter.recordFailure("10.0.0.31");
      expect(limiter.check("10.0.0.31").allowed).toBe(false);

      // Move past the window but NOT past the lockout.
      vi.advanceTimersByTime(6_000);
      limiter.prune();
      expect(limiter.size()).toBe(1); // Still locked-out, not pruned.
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps oversized positive auto-prune intervals", () => {
    vi.useFakeTimers();
    try {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      limiter = createAuthRateLimiter({ pruneIntervalMs: Number.MAX_SAFE_INTEGER });

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------- undefined / empty IP ----------

  it("normalizes undefined IP to 'unknown'", () => {
    createLimiter();
    limiter.recordFailure(undefined);
    limiter.recordFailure(undefined);
    expect(limiter.check(undefined).allowed).toBe(false);
    expect(limiter.size()).toBe(1);
  });

  it("normalizes empty-string IP to 'unknown'", () => {
    createLimiter();
    limiter.recordFailure("");
    limiter.recordFailure("");
    expect(limiter.check("").allowed).toBe(false);
  });

  // ---------- dispose ----------

  it("dispose clears all entries", () => {
    limiter = createAuthRateLimiter();
    limiter.recordFailure("10.0.0.40");
    expect(limiter.size()).toBe(1);
    limiter.dispose();
    expect(limiter.size()).toBe(0);
  });
});
