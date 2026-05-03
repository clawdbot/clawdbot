import { describe, expect, it } from "vitest";
import { PluginLoaderCacheState, PluginLoadReentryError } from "./loader-cache-state.js";

describe("PluginLoaderCacheState", () => {
  it("evicts the least recently used registry cache entry", () => {
    const cache = new PluginLoaderCacheState<string>(2);

    cache.set("", "empty");
    cache.set("a", "alpha");
    cache.set("b", "bravo");
    expect(cache.get("a")).toBe("alpha");

    cache.set("c", "charlie");

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("alpha");
    expect(cache.get("c")).toBe("charlie");
  });

  it("tracks in-flight loads and reports reentry by cache key", () => {
    const cache = new PluginLoaderCacheState<string>(2);

    cache.beginLoad("demo");
    expect(cache.isLoadInFlight("demo")).toBe(true);
    expect(() => cache.beginLoad("demo")).toThrow(PluginLoadReentryError);

    cache.finishLoad("demo");
    expect(cache.isLoadInFlight("demo")).toBe(false);
  });

  it("clears registry, in-flight, and warning state together", () => {
    const cache = new PluginLoaderCacheState<string>(2);

    cache.set("demo", "registry");
    cache.beginLoad("demo");
    cache.recordOpenAllowlistWarning("demo-warning");

    cache.clear();

    expect(cache.get("demo")).toBeUndefined();
    expect(cache.isLoadInFlight("demo")).toBe(false);
    expect(cache.hasOpenAllowlistWarning("demo-warning")).toBe(false);
  });

  it("clears cached registries without dropping in-flight load guards", () => {
    const cache = new PluginLoaderCacheState<string>(2);

    cache.set("demo", "registry");
    cache.beginLoad("demo");
    cache.recordOpenAllowlistWarning("demo-warning");

    cache.clearCachedRegistries();

    expect(cache.get("demo")).toBeUndefined();
    expect(cache.isLoadInFlight("demo")).toBe(true);
    expect(cache.hasOpenAllowlistWarning("demo-warning")).toBe(false);
  });
});
