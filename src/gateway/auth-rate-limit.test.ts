import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Auth rate-limit tests cover sliding-window, lockout, scope, loopback, and
// cleanup behavior shared by gateway secret and device-token authentication.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  buildRateLimitIdentityKey,
  createAuthRateLimiter,
  isAuthRateLimitClientExempt,
} from "./auth-rate-limit.js";

describe("auth rate limiter", () => {
  let limiter: ReturnType<typeof createAuthRateLimiter>;
  const baseConfig = { maxAttempts: 2, windowMs: 60_000, lockoutMs: 60_000 };

  function createLimiter(
    overrides?: Partial<{
      maxAttempts: number;
      windowMs: number;
      lockoutMs: number;
      exemptLoopback: boolean;
      pruneIntervalMs: number;
      maxEntries: number;
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

  it("applies new limits to retained scope history without releasing earned lockouts", () => {
    vi.useFakeTimers();
    try {
      createLimiter({ maxAttempts: 5, windowMs: 10_000, pruneIntervalMs: 0 });
      const ip = "10.0.0.5";
      limiter.recordFailure(ip, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
      limiter.recordFailure(ip, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
      limiter.recordFailure(ip, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);

      limiter.updateConfig({ maxAttempts: 2, windowMs: 10_000, lockoutMs: 4_000 });
      expect(limiter.check(ip, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET)).toEqual({
        allowed: false,
        remaining: 0,
        retryAfterMs: 4_000,
      });
      expect(limiter.check(ip, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).remaining).toBe(1);

      vi.advanceTimersByTime(1_000);
      limiter.updateConfig({ maxAttempts: 4, windowMs: 10_000, lockoutMs: 9_000 });
      expect(limiter.check(ip, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET).retryAfterMs).toBe(3_000);
      expect(limiter.check(ip, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).remaining).toBe(3);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        limiter.recordFailure(ip, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
      }
      expect(limiter.check(ip, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).retryAfterMs).toBe(9_000);

      vi.advanceTimersByTime(3_000);
      expect(limiter.check(ip, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET)).toEqual({
        allowed: true,
        remaining: 4,
        retryAfterMs: 0,
      });
      expect(limiter.check(ip, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).retryAfterMs).toBe(6_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces window settings and restores omitted defaults without erasing history", () => {
    vi.useFakeTimers();
    try {
      createLimiter({
        maxAttempts: 5,
        windowMs: 1_000,
        exemptLoopback: false,
        pruneIntervalMs: 0,
      });
      const ip = "10.0.0.6";
      limiter.recordFailure(ip);
      vi.advanceTimersByTime(1_500);

      limiter.updateConfig({ maxAttempts: 3, windowMs: 5_000 });
      expect(limiter.check(ip).remaining).toBe(2);
      expect(isAuthRateLimitClientExempt(limiter, "127.0.0.1")).toBe(true);
      limiter.updateConfig({ maxAttempts: 3, windowMs: 1_000 });
      expect(limiter.check(ip).remaining).toBe(3);

      limiter.recordFailure(ip);
      vi.advanceTimersByTime(1_500);
      limiter.updateConfig();
      expect(limiter.check(ip).remaining).toBe(9);
      for (let attempt = 0; attempt < 9; attempt += 1) {
        limiter.recordFailure(ip);
      }
      expect(limiter.check(ip).retryAfterMs).toBe(300_000);
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

  it("caps unique client entries under flood", () => {
    createLimiter({ maxEntries: 3, pruneIntervalMs: 0 });

    limiter.recordFailure("10.0.1.1");
    limiter.recordFailure("10.0.1.2");
    limiter.recordFailure("10.0.1.3");
    limiter.recordFailure("10.0.1.4");

    expect(limiter.size()).toBe(3);
    expect(limiter.check("10.0.1.1").remaining).toBe(2);
    expect(limiter.check("10.0.1.4").remaining).toBe(1);
  });

  it("preserves locked entries when flood eviction runs", () => {
    createLimiter({ maxEntries: 3, pruneIntervalMs: 0 });

    limiter.recordFailure("10.0.2.1");
    limiter.recordFailure("10.0.2.1");
    expect(limiter.check("10.0.2.1").allowed).toBe(false);
    limiter.recordFailure("10.0.2.2");
    limiter.recordFailure("10.0.2.3");

    limiter.recordFailure("10.0.2.4");

    expect(limiter.size()).toBe(3);
    expect(limiter.check("10.0.2.1").allowed).toBe(false);
    expect(limiter.check("10.0.2.2").remaining).toBe(2);
    expect(limiter.check("10.0.2.4").remaining).toBe(1);
  });

  it("preserves overflow and tracked lockouts when policy changes while the table is full", () => {
    vi.useFakeTimers();
    try {
      limiter = createAuthRateLimiter({
        maxAttempts: 1,
        windowMs: 60_000,
        lockoutMs: 60_000,
        maxEntries: 2,
        pruneIntervalMs: 0,
      });

      limiter.recordFailure("10.0.3.1");
      limiter.recordFailure("10.0.3.2");
      limiter.recordFailure("10.0.3.3");

      expect(limiter.size()).toBe(2);
      expect(limiter.check("10.0.3.1").allowed).toBe(false);
      expect(limiter.check("10.0.3.2").allowed).toBe(false);
      const overflowResult = limiter.check("10.0.3.3");
      expect(overflowResult.allowed).toBe(false);
      expect(overflowResult.retryAfterMs).toBeGreaterThan(0);

      vi.advanceTimersByTime(1_000);
      limiter.updateConfig({ maxAttempts: 20, windowMs: 1, lockoutMs: 1 });
      for (const ip of ["10.0.3.1", "10.0.3.2", "10.0.3.3"]) {
        expect(limiter.check(ip)).toEqual({
          allowed: false,
          remaining: 0,
          retryAfterMs: 59_000,
        });
      }
      expect(limiter.size()).toBe(2);

      vi.advanceTimersByTime(59_001);
      expect(limiter.check("10.0.3.3").allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { value: 0, expectedSize: 1 },
    { value: -2, expectedSize: 1 },
    { value: 1.9, expectedSize: 1 },
    { value: 2.9, expectedSize: 2 },
    { value: Number.NaN, expectedSize: 2 },
    { value: Number.POSITIVE_INFINITY, expectedSize: 2 },
  ])("normalizes maxEntries value $value", ({ value, expectedSize }) => {
    limiter = createAuthRateLimiter({
      maxAttempts: 2,
      windowMs: 60_000,
      lockoutMs: 60_000,
      maxEntries: value,
      pruneIntervalMs: 0,
    });

    limiter.recordFailure("10.0.4.1");
    limiter.recordFailure("10.0.4.2");

    expect(limiter.size()).toBe(expectedSize);
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
    for (let attempt = 0; attempt < 20; attempt += 1) {
      limiter.recordFailure(ip);
    }
    expect(limiter.check(ip).allowed).toBe(true);
  });

  it.each([false, true])(
    "escalates and caps loopback delay with an existing lockout: %s",
    async (locked) => {
      vi.useFakeTimers();
      try {
        limiter = createAuthRateLimiter({
          maxAttempts: 1,
          windowMs: 60_000,
          lockoutMs: 60_000,
          exemptLoopback: !locked,
          pruneIntervalMs: 0,
        });
        const ip = "127.0.0.1";
        if (locked) {
          limiter.recordFailure(ip);
          expect(limiter.check(ip).retryAfterMs).toBe(60_000);
          limiter.updateConfig({ maxAttempts: 1, exemptLoopback: true });
        }
        const firstDelay = locked ? 500 : 250;

        const first = limiter.recordFailureAndDelay(ip);
        await vi.advanceTimersByTimeAsync(firstDelay - 1);
        let settled = false;
        void first.then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await first;

        const second = limiter.recordFailureAndDelay(ip);
        await vi.advanceTimersByTimeAsync(firstDelay * 2 - 1);
        settled = false;
        void second.then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await second;

        for (let attempt = 0; attempt < 100; attempt += 1) {
          limiter.recordFailure(ip);
        }
        const capped = limiter.recordFailureAndDelay(ip);
        await vi.advanceTimersByTimeAsync(4_999);
        settled = false;
        void capped.then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await capped;
        expect(limiter.check(ip).allowed).toBe(true);
        if (locked) {
          limiter.updateConfig({ exemptLoopback: false });
          expect(limiter.check(ip).retryAfterMs).toBe(60_000 - firstDelay * 3 - 5_000);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { policy: "exempt", config: { maxAttempts: 2, exemptLoopback: true }, remaining: 1 },
    { policy: "nonexempt", config: { maxAttempts: 2, exemptLoopback: false }, remaining: 1 },
    { policy: "default", config: undefined, remaining: 9 },
  ])("retires expired locks before counting fresh $policy failures", ({ config, remaining }) => {
    vi.useFakeTimers();
    try {
      createLimiter({ lockoutMs: 1_000, exemptLoopback: false, pruneIntervalMs: 0 });
      const ip = "127.0.0.1";
      limiter.recordFailure(ip);
      limiter.recordFailure(ip);
      expect(limiter.check(ip).retryAfterMs).toBe(1_000);

      limiter.updateConfig(config);
      vi.advanceTimersByTime(1_000);
      limiter.recordFailure(ip);
      limiter.updateConfig({ ...config, exemptLoopback: false });

      expect(limiter.check(ip)).toEqual({ allowed: true, remaining, retryAfterMs: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset clears the loopback penalty history", async () => {
    vi.useFakeTimers();
    try {
      limiter = createAuthRateLimiter({ pruneIntervalMs: 0 });
      limiter.recordFailure("127.0.0.1");
      limiter.recordFailure("127.0.0.1");
      limiter.reset("127.0.0.1");

      const delayed = limiter.recordFailureAndDelay("127.0.0.1");
      await vi.advanceTimersByTimeAsync(249);
      let settled = false;
      void delayed.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await delayed;
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: an earlier revision skipped the delay once a global timer cap was
  // full, so an attacker could park cheap failures in every slot and then guess
  // without penalty. Concurrency must never buy a faster answer than one attempt.
  it("still delays loopback failures when many are already pending", async () => {
    vi.useFakeTimers();
    try {
      limiter = createAuthRateLimiter({ pruneIntervalMs: 0 });
      const pending = Array.from({ length: 64 }, (_, index) =>
        limiter.recordFailureAndDelay("127.0.0.1", `scope-${index}`),
      );

      let extraSettled = false;
      const extra = limiter.recordFailureAndDelay("127.0.0.1", "scope-extra").then(() => {
        extraSettled = true;
      });
      await Promise.resolve();
      expect(extraSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(250);
      await extra;
      expect(extraSettled).toBe(true);

      limiter.dispose();
      await Promise.all(pending);
    } finally {
      vi.useRealTimers();
    }
  });

  // Parallel guesses on one key share the key's deadline instead of each starting
  // a fresh short timer, so fanning out cannot outrun the escalating penalty.
  it("preserves a shared earned delay across history reset and policy changes", async () => {
    vi.useFakeTimers();
    try {
      limiter = createAuthRateLimiter({ maxAttempts: 2, pruneIntervalMs: 0 });
      const settled: string[] = [];
      const first = limiter.recordFailureAndDelay("127.0.0.1", "shared").then(() => {
        settled.push("first");
      });
      const second = limiter.recordFailureAndDelay("127.0.0.1", "shared").then(() => {
        settled.push("second");
      });
      await vi.advanceTimersByTimeAsync(100);
      limiter.reset("127.0.0.1", "shared");
      limiter.updateConfig({ maxAttempts: 1, exemptLoopback: false });
      const current = limiter.recordFailureAndDelay("127.0.0.1", "shared");
      expect(limiter.check("127.0.0.1", "shared").allowed).toBe(false);
      await current;
      await vi.advanceTimersByTimeAsync(399);
      expect(settled).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([first, second]);
      expect(settled).toEqual(["first", "second"]);
    } finally {
      vi.useRealTimers();
    }
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

  it("reports the authoritative exemption policy for fallback serialization", () => {
    limiter = createAuthRateLimiter({ maxAttempts: 1 });
    expect(isAuthRateLimitClientExempt(limiter, "127.0.0.1")).toBe(true);
    expect(isAuthRateLimitClientExempt(limiter, buildRateLimitIdentityKey("node", "node-1"))).toBe(
      false,
    );
    limiter.recordFailure("127.0.0.1");
    limiter.updateConfig({ maxAttempts: 1, exemptLoopback: false });
    expect(isAuthRateLimitClientExempt(limiter, "127.0.0.1")).toBe(false);
    expect(limiter.check("127.0.0.1").allowed).toBe(false);
    limiter.updateConfig();
    expect(isAuthRateLimitClientExempt(limiter, "127.0.0.1")).toBe(true);
    expect(limiter.check("127.0.0.1").allowed).toBe(true);
    limiter.updateConfig({ exemptLoopback: false });
    expect(limiter.check("127.0.0.1").allowed).toBe(false);
  });

  it("does not exempt opaque identity keys", () => {
    limiter = createAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    const key = buildRateLimitIdentityKey("node", "node-1");
    limiter.recordFailure(key);
    expect(limiter.check(key).allowed).toBe(false);
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

  it.each([5_000, 60_000])(
    "prune retires expired lock histories with a %sms window",
    (windowMs) => {
      vi.useFakeTimers();
      try {
        limiter = createAuthRateLimiter({ maxAttempts: 1, windowMs, lockoutMs: 30_000 });
        limiter.recordFailure("10.0.0.31");
        expect(limiter.check("10.0.0.31").allowed).toBe(false);

        vi.advanceTimersByTime(6_000);
        limiter.prune();
        expect(limiter.size()).toBe(1); // Still locked-out, not pruned.
        vi.advanceTimersByTime(24_000);
        limiter.prune();
        expect(limiter.size()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

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

  it("dispose settles pending loopback failure delays immediately", async () => {
    vi.useFakeTimers();
    try {
      limiter = createAuthRateLimiter({ pruneIntervalMs: 0 });
      const pending = limiter.recordFailureAndDelay("127.0.0.1");

      limiter.dispose();

      await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
