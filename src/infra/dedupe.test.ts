// Covers process-local dedupe cache behavior.
import { describe, expect, it } from "vitest";
import { createDedupeCache } from "./dedupe.js";

describe("createDedupeCache", () => {
  it("ignores blank cache keys", () => {
    const cache = createDedupeCache({ ttlMs: 1_000, maxSize: 10 });

    expect(cache.check("", 100)).toBe(false);
    expect(cache.check(undefined, 100)).toBe(false);
    expect(cache.peek(null, 100)).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("keeps entries indefinitely when ttlMs is zero or negative", () => {
    const zeroTtlCache = createDedupeCache({ ttlMs: 0, maxSize: 10 });
    expect(zeroTtlCache.check("a", 100)).toBe(false);
    expect(zeroTtlCache.check("a", 10_000)).toBe(true);

    const negativeTtlCache = createDedupeCache({ ttlMs: -100, maxSize: 10 });
    expect(negativeTtlCache.check("b", 100)).toBe(false);
    expect(negativeTtlCache.peek("b", 10_000)).toBe(true);
  });

  it("touches duplicate reads so the newest key survives max-size pruning", () => {
    const cache = createDedupeCache({ ttlMs: 10_000, maxSize: 2 });

    expect(cache.check("a", 100)).toBe(false);
    expect(cache.check("b", 200)).toBe(false);
    expect(cache.check("a", 300)).toBe(true);
    expect(cache.check("c", 400)).toBe(false);

    expect(cache.peek("a", 500)).toBe(true);
    expect(cache.peek("b", 500)).toBe(false);
    expect(cache.peek("c", 500)).toBe(true);

    expect(cache.check("b", 600)).toBe(false);
    expect(cache.peek("a", 700)).toBe(false);
    expect(cache.peek("b", 700)).toBe(true);
    expect(cache.peek("c", 700)).toBe(true);
  });

  it("clears itself when maxSize floors to zero", () => {
    const cache = createDedupeCache({ ttlMs: 1_000, maxSize: 0.9 });

    expect(cache.check("a", 100)).toBe(false);
    expect(cache.size()).toBe(0);
    expect(cache.peek("a", 200)).toBe(false);
  });

  it("supports explicit reset", () => {
    const cache = createDedupeCache({ ttlMs: 1_000, maxSize: 10 });

    expect(cache.check("a", 100)).toBe(false);
    expect(cache.check("b", 200)).toBe(false);
    expect(cache.size()).toBe(2);

    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.peek("a", 300)).toBe(false);
  });
});
