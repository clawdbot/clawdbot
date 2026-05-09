import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeManagedCacheEntries,
  getOrCreateManagedCacheEntry,
  resolveSingletonManagedCache,
  type ManagedCache,
} from "./manager-cache.js";

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

function createDeferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

describe("manager cache", () => {
  const cachesForCleanup: ManagedCache<TestEntry>[] = [];

  afterEach(async () => {
    await Promise.all(
      cachesForCleanup.splice(0).map((cache) =>
        closeManagedCacheEntries({
          cache: cache.cache,
          pending: cache.pending,
        }),
      ),
    );
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

  it("waits for pending creation before global teardown closes cached entries", async () => {
    const cache = createTestCache();
    const first = createEntry("first");
    const second = createEntry("second");
    cachesForCleanup.push(cache);
    const gate = createDeferred<void>();

    const pendingFirst = getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      key: "same",
      create: async () => {
        await gate.promise;
        return first;
      },
    });

    const teardown = closeManagedCacheEntries({
      cache: cache.cache,
      pending: cache.pending,
    });
    gate.resolve();

    await teardown;
    expect(first.close).toHaveBeenCalledTimes(1);

    const resolvedFirst = await pendingFirst;
    const resolvedSecond = await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      key: "same",
      create: async () => second,
    });

    expect(resolvedFirst).toBe(first);
    expect(resolvedSecond).toBe(second);
    expect(resolvedSecond).not.toBe(resolvedFirst);
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
