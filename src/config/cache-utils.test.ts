// Covers synchronous config cache behavior.
import { describe, expect, it } from "vitest";
import { createExpiringMapCache } from "./cache-utils.js";

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
