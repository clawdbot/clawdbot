import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { DirectoryCache, buildDirectoryCacheKey } from "./directory-cache.js";
import type { DirectoryCacheKey } from "./directory-cache.js";

describe("buildDirectoryCacheKey", () => {
  it.each([
    {
      input: {
        channel: "workspace",
        kind: "channel",
        source: "cache",
      },
      expected: "workspace:default:channel:cache:default",
    },
    {
      input: {
        channel: "richchat",
        accountId: "work",
        kind: "user",
        source: "live",
        signature: "v2",
      },
      expected: "richchat:work:user:live:v2",
    },
  ] satisfies Array<{ input: DirectoryCacheKey; expected: string }>)(
    "includes account and signature fallbacks for %j",
    ({ input, expected }) => {
      expect(buildDirectoryCacheKey(input)).toBe(expected);
    },
  );
});

describe("DirectoryCache", () => {
  it("expires entries after ttl and resets when config ref changes", () => {
    vi.useFakeTimers();
    const cache = new DirectoryCache<string>(1_000);
    const cfgA = {} as OpenClawConfig;
    const cfgB = {} as OpenClawConfig;

    cache.set("a", "first", cfgA);
    expect(cache.get("a", cfgA)).toBe("first");

    vi.advanceTimersByTime(1_001);
    expect(cache.get("a", cfgA)).toBeUndefined();

    cache.set("b", "second", cfgA);
    expect(cache.get("b", cfgB)).toBeUndefined();

    vi.useRealTimers();
  });

  it("evicts least-recent entries, refreshes insertion order, and clears matches", () => {
    const cache = new DirectoryCache<string>(60_000, 2);
    const cfg = {} as OpenClawConfig;

    cache.set("a", "A", cfg);
    cache.set("b", "B", cfg);
    cache.set("a", "A2", cfg);
    cache.set("c", "C", cfg);

    expect(cache.get("a", cfg)).toBe("A2");
    expect(cache.get("b", cfg)).toBeUndefined();
    expect(cache.get("c", cfg)).toBe("C");

    cache.clearMatching((key) => key.startsWith("c"));
    expect(cache.get("c", cfg)).toBeUndefined();

    cache.clear(cfg);
    expect(cache.get("a", cfg)).toBeUndefined();
  });
});
