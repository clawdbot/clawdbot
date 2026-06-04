// Covers config cache utility invalidation and snapshot behavior.
import { describe, expect, it } from "vitest";
import { createExpiringMapCache, resolveCacheTtlMs } from "./cache-utils.js";

describe("resolveCacheTtlMs", () => {
  it("accepts exact non-negative integers", () => {
    expect(resolveCacheTtlMs({ envValue: "0", defaultTtlMs: 60_000 })).toBe(0);
    expect(resolveCacheTtlMs({ envValue: "120000", defaultTtlMs: 60_000 })).toBe(120_000);
  });

  it("rejects malformed env values and falls back to the default", () => {
    expect(resolveCacheTtlMs({ envValue: "0abc", defaultTtlMs: 60_000 })).toBe(60_000);
    expect(resolveCacheTtlMs({ envValue: "15ms", defaultTtlMs: 60_000 })).toBe(60_000);
  });
});

describe("createExpiringMapCache", () => {
  it("expires entries on read after the TTL", () => {
    let now = 1_000;
    const cache = createExpiringMapCache<string, string>({
      ttlMs: 5_000,
      clock: () => now,
    });

    cache.set("alpha", "a");
    expect(cache.get("alpha")).toBe("a");

    now = 6_001;
    expect(cache.get("alpha")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("supports dynamic TTLs and opportunistic pruning", () => {
    let now = 1_000;
    let ttlMs = 5_000;
    const cache = createExpiringMapCache<string, string>({
      ttlMs: () => ttlMs,
      pruneIntervalMs: 1_000,
      clock: () => now,
    });

    cache.set("stale", "old");
    now = 7_000;
    ttlMs = 2_000;

    cache.set("fresh", "new");

    expect(cache.get("stale")).toBeUndefined();
    expect(cache.keys()).toEqual(["fresh"]);
  });
});
