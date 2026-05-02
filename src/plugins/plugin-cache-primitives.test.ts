import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  PluginLruCache,
  resolveConfigScopedRuntimeCacheValue,
  type ConfigScopedRuntimeCache,
} from "./plugin-cache-primitives.js";

describe("PluginLruCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new PluginLruCache<string>(2);

    cache.set("", "empty");
    cache.set("a", "alpha");
    cache.set("b", "bravo");
    expect(cache.get("a")).toBe("alpha");

    cache.set("c", "charlie");

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("alpha");
    expect(cache.get("c")).toBe("charlie");
  });

  it("returns hit state for cached null values", () => {
    const cache = new PluginLruCache<string | null>(2);

    cache.set("missing", null);

    expect(cache.getResult("missing")).toEqual({ hit: true, value: null });
    expect(cache.getResult("unknown")).toEqual({ hit: false });
  });

  it("resizes and falls back to the default max entry count", () => {
    const cache = new PluginLruCache<string>(2);

    cache.setMaxEntriesForTest(1.9);
    cache.set("a", "alpha");
    cache.set("b", "bravo");
    expect(cache.maxEntries).toBe(1);
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBeUndefined();

    cache.setMaxEntriesForTest();
    expect(cache.maxEntries).toBe(2);
  });
});

describe("resolveConfigScopedRuntimeCacheValue", () => {
  it("caches values by config object and key", () => {
    const cache: ConfigScopedRuntimeCache<string[]> = new WeakMap();
    const config = {} as OpenClawConfig;
    const load = vi.fn(() => ["loaded"]);

    expect(resolveConfigScopedRuntimeCacheValue({ cache, config, key: "demo", load })).toEqual([
      "loaded",
    ]);
    expect(resolveConfigScopedRuntimeCacheValue({ cache, config, key: "demo", load })).toEqual([
      "loaded",
    ]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("does not cache values without a config owner", () => {
    const cache: ConfigScopedRuntimeCache<string> = new WeakMap();
    const load = vi.fn(() => "loaded");

    expect(resolveConfigScopedRuntimeCacheValue({ cache, key: "demo", load })).toBe("loaded");
    expect(resolveConfigScopedRuntimeCacheValue({ cache, key: "demo", load })).toBe("loaded");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("caches undefined values by key", () => {
    const cache: ConfigScopedRuntimeCache<string | undefined> = new WeakMap();
    const config = {} as OpenClawConfig;
    const load = vi.fn(() => undefined);

    expect(resolveConfigScopedRuntimeCacheValue({ cache, config, key: "missing", load })).toBe(
      undefined,
    );
    expect(resolveConfigScopedRuntimeCacheValue({ cache, config, key: "missing", load })).toBe(
      undefined,
    );
    expect(load).toHaveBeenCalledOnce();
  });
});
