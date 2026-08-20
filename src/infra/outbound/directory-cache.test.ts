// Covers directory cache key dimensions, TTL expiration, config invalidation,
// recency refresh, bounded eviction, and matching clears.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { DirectoryCache, buildDirectoryCacheKey } from "./directory-cache.js";

describe("buildDirectoryCacheKey", () => {
  it.each([
    {
      input: {
        channel: "workspace",
        kind: "channel",
        source: "cache",
      },
      expected: "workspace:default:channel:cache:default:query:",
    },
    {
      input: {
        channel: "richchat",
        accountId: "work",
        kind: "user",
        source: "live",
        signature: "v2",
        query: "alice",
      },
      expected: "richchat:work:user:live:v2:query:alice",
    },
  ] satisfies Array<{
    input: Parameters<typeof buildDirectoryCacheKey>[0];
    expected: string;
  }>)("includes account and signature fallbacks for %j", ({ input, expected }) => {
    expect(buildDirectoryCacheKey(input)).toBe(expected);
  });
});

describe("DirectoryCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires entries at ttl and partitions entries by config identity", () => {
    vi.useFakeTimers();
    const cache = new DirectoryCache<string>(1_000);
    const cfgA = {} as OpenClawConfig;
    const cfgB = {} as OpenClawConfig;

    cache.set("a", "first", cfgA);
    expect(cache.get("a", cfgA)).toBe("first");

    vi.advanceTimersByTime(1_000);
    expect(cache.get("a", cfgA)).toBeUndefined();

    cache.set("b", "second", cfgA);
    expect(cache.get("b", cfgB)).toBeUndefined();
    expect(cache.get("b", cfgA)).toBe("second");
  });

  it("evicts least-recent entries, refreshes insertion order, and clears matches", () => {
    const cache = new DirectoryCache<string>(60_000, 2);
    const cfg = {} as OpenClawConfig;
    const otherCfg = {} as OpenClawConfig;

    cache.set("a", "A", cfg);
    cache.set("b", "B", cfg);
    cache.set("a", "A2", cfg);
    cache.set("c", "C", cfg);

    expect(cache.get("a", cfg)).toBe("A2");
    expect(cache.get("b", cfg)).toBeUndefined();
    expect(cache.get("c", cfg)).toBe("C");

    cache.set("c", "other-C", otherCfg);
    cache.clearMatching((key) => key.startsWith("c"), cfg);
    expect(cache.get("c", cfg)).toBeUndefined();
    expect(cache.get("c", otherCfg)).toBe("other-C");

    cache.clear(cfg);
    expect(cache.get("a", cfg)).toBeUndefined();
  });

  it("uses the default max size when maxSize is non-finite", () => {
    const cache = new DirectoryCache<number>(60_000, Number.NaN);
    const cfg = {} as OpenClawConfig;

    for (let i = 0; i <= 2000; i++) {
      cache.set(`key-${i}`, i, cfg);
    }

    expect(cache.get("key-0", cfg)).toBeUndefined();
    expect(cache.get("key-2000", cfg)).toBe(2000);
  });
});
