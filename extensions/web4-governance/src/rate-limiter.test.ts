import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "./rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  describe("check", () => {
    it("should allow when no actions recorded", () => {
      const result = limiter.check("key1", 5, 60_000);
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(0);
      expect(result.limit).toBe(5);
    });

    it("should allow when under limit", () => {
      limiter.record("key1");
      limiter.record("key1");
      const result = limiter.check("key1", 5, 60_000);
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(2);
    });

    it("should deny when at limit", () => {
      for (let i = 0; i < 5; i++) limiter.record("key1");
      const result = limiter.check("key1", 5, 60_000);
      expect(result.allowed).toBe(false);
      expect(result.current).toBe(5);
    });

    it("should deny when over limit", () => {
      for (let i = 0; i < 10; i++) limiter.record("key1");
      const result = limiter.check("key1", 5, 60_000);
      expect(result.allowed).toBe(false);
      expect(result.current).toBe(10);
    });
  });

  describe("window expiry", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should expire old entries", () => {
      vi.setSystemTime(1000);
      limiter.record("key1");
      limiter.record("key1");
      limiter.record("key1");

      // Move time forward past window
      vi.setSystemTime(62_000);
      const result = limiter.check("key1", 3, 60_000);
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(0);
    });

    it("should keep recent entries within window", () => {
      vi.setSystemTime(1000);
      limiter.record("key1");

      vi.setSystemTime(30_000);
      limiter.record("key1");

      vi.setSystemTime(59_000);
      // First entry is within 60s window (59000 - 1000 = 58000 < 60000)
      const result = limiter.check("key1", 3, 60_000);
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(2);
    });

    it("should partially expire entries", () => {
      vi.setSystemTime(1000);
      limiter.record("key1"); // will expire

      vi.setSystemTime(50_000);
      limiter.record("key1"); // will survive

      vi.setSystemTime(70_000);
      // cutoff = 70000 - 60000 = 10000, so t=1000 expires, t=50000 survives
      const result = limiter.check("key1", 2, 60_000);
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(1);
    });
  });

  describe("concurrent keys", () => {
    it("should track keys independently", () => {
      for (let i = 0; i < 5; i++) limiter.record("bash");
      limiter.record("read");

      expect(limiter.check("bash", 5, 60_000).allowed).toBe(false);
      expect(limiter.check("read", 5, 60_000).allowed).toBe(true);
    });

    it("should report correct keyCount", () => {
      expect(limiter.keyCount).toBe(0);
      limiter.record("a");
      limiter.record("b");
      limiter.record("c");
      expect(limiter.keyCount).toBe(3);
    });
  });

  describe("record", () => {
    it("should create key on first record", () => {
      expect(limiter.count("new")).toBe(0);
      limiter.record("new");
      expect(limiter.count("new")).toBe(1);
    });

    it("should increment count", () => {
      limiter.record("key1");
      limiter.record("key1");
      limiter.record("key1");
      expect(limiter.count("key1")).toBe(3);
    });
  });

  describe("prune", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should remove expired entries across all keys", () => {
      vi.setSystemTime(1000);
      limiter.record("a");
      limiter.record("b");

      vi.setSystemTime(70_000);
      const pruned = limiter.prune(60_000);
      expect(pruned).toBe(2);
      expect(limiter.keyCount).toBe(0);
    });

    it("should keep recent entries during prune", () => {
      vi.setSystemTime(1000);
      limiter.record("a"); // will expire

      vi.setSystemTime(50_000);
      limiter.record("a"); // will survive

      vi.setSystemTime(70_000);
      const pruned = limiter.prune(60_000);
      expect(pruned).toBe(1);
      expect(limiter.count("a")).toBe(1);
    });

    it("should return 0 when nothing to prune", () => {
      limiter.record("a");
      const pruned = limiter.prune(60_000);
      expect(pruned).toBe(0);
    });
  });

  describe("static key", () => {
    it("should build namespaced key", () => {
      expect(RateLimiter.key("rule1", "Bash")).toBe("ratelimit:rule1:Bash");
      expect(RateLimiter.key("deny-net", "network")).toBe("ratelimit:deny-net:network");
    });
  });
});
