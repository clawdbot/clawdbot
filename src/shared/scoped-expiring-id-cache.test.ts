import { describe, expect, it } from "vitest";
import { createScopedExpiringIdCache } from "./scoped-expiring-id-cache.js";

describe("createScopedExpiringIdCache", () => {
  it("expires ids after the configured ttl", () => {
    const store = new Map<string, Map<string, number>>();
    const cache = createScopedExpiringIdCache<string, string>({
      store,
      ttlMs: 10,
      cleanupThreshold: 100,
    });

    cache.record("scope", "old", 100);

    expect(cache.has("scope", "old", 110)).toBe(true);
    expect(cache.has("scope", "old", 111)).toBe(false);
    expect(store.has("scope")).toBe(false);
  });

  it("falls back for non-finite ttl and cleanup threshold options", () => {
    const store = new Map<string, Map<string, number>>();
    const cache = createScopedExpiringIdCache<string, string>({
      store,
      ttlMs: Number.NaN,
      cleanupThreshold: Number.POSITIVE_INFINITY,
    });

    cache.record("scope", "old", 100);
    cache.record("scope", "fresh", 101);

    expect(store.get("scope")?.has("old")).toBe(false);
    expect(store.get("scope")?.has("fresh")).toBe(true);
  });

  it("clears all scoped ids", () => {
    const store = new Map<string, Map<string, number>>();
    const cache = createScopedExpiringIdCache<string, string>({
      store,
      ttlMs: 10,
      cleanupThreshold: 100,
    });

    cache.record("scope", "id", 100);
    cache.clear();

    expect(store.size).toBe(0);
  });
});
