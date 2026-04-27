import { describe, expect, it } from "vitest";
import { PluginLruCache } from "./plugin-lru-cache.js";

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
