import { afterEach, describe, expect, it, vi } from "vitest";
// Memory Core tests cover manager cache plugin behavior.
import { getOrCreateManagedCacheEntry, resolveSingletonManagedCache } from "./manager-cache.js";

type ManagedCache<T> = ReturnType<typeof resolveSingletonManagedCache<T>>;

type TestEntry = {
  id: string;
  close: () => Promise<void>;
};

function createTestCache(): ManagedCache<TestEntry> {
  return resolveSingletonManagedCache<TestEntry>(Symbol("openclaw.manager-cache.test"));
}

function createEntry(id: string): TestEntry {
  return {
    id,
    close: vi.fn(async () => {}),
  };
}

describe("manager cache", () => {
  const cachesForCleanup: ManagedCache<TestEntry>[] = [];

  afterEach(async () => {
    for (const cache of cachesForCleanup.splice(0)) {
      await Promise.allSettled(cache.pending.values());
      await Promise.allSettled(Array.from(cache.cache.values(), (entry) => entry.close()));
      cache.cache.clear();
      cache.pending.clear();
    }
  });

  it("repairs an invalid singleton cache shape", async () => {
    const cacheKey = Symbol("openclaw.manager-cache.corrupt-test");
    (globalThis as Record<PropertyKey, unknown>)[cacheKey] = {};

    const cache = resolveSingletonManagedCache<TestEntry>(cacheKey);
    cachesForCleanup.push(cache);
    const entry = await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      key: "same",
      create: async () => createEntry("repaired"),
    });

    expect(entry.id).toBe("repaired");
    expect(cache.cache).toBeInstanceOf(Map);
    expect(cache.pending).toBeInstanceOf(Map);
    delete (globalThis as Record<PropertyKey, unknown>)[cacheKey];
  });

  it("deduplicates concurrent creation for the same cache key", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    let createCalls = 0;

    const results = await Promise.all(
      Array.from(
        { length: 12 },
        async () =>
          await getOrCreateManagedCacheEntry({
            cache: cache.cache,
            pending: cache.pending,
            key: "same",
            create: async () => {
              createCalls += 1;
              await Promise.resolve();
              return createEntry("shared");
            },
          }),
      ),
    );

    expect(results).toHaveLength(12);
    expect(new Set(results).size).toBe(1);
    expect(createCalls).toBe(1);
  });

  it("bypasses identity caching for status-only callers", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    let createCalls = 0;

    const first = await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      key: "same",
      bypassCache: true,
      create: async () => {
        createCalls += 1;
        return createEntry(`status-${createCalls}`);
      },
    });
    const second = await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      key: "same",
      bypassCache: true,
      create: async () => {
        createCalls += 1;
        return createEntry(`status-${createCalls}`);
      },
    });

    expect(first).not.toBe(second);
    expect(createCalls).toBe(2);
    expect(cache.cache.size).toBe(0);
  });
});
