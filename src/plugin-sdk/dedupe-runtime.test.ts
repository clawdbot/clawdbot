import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistentDedupeCache } from "./dedupe-runtime.js";

type Record = { at: number };

function createMemoryStore() {
  const entries = new Map<string, Record>();
  return {
    entries,
    store: {
      register: vi.fn(async (key: string, value: Record) => {
        entries.set(key, value);
      }),
      lookup: vi.fn(async (key: string) => entries.get(key)),
    },
  };
}

function createCache(params?: {
  openStore?: () => ReturnType<typeof createMemoryStore>["store"] | undefined;
  logError?: (error: unknown) => void;
  readTimestamp?: (record: Record) => number | undefined;
  ttlMs?: number;
  maxSize?: number;
  persistentMaxEntries?: number;
}) {
  const backing = createMemoryStore();
  const cache = createPersistentDedupeCache<Record>({
    // Plain Symbol() is unique per cache, so parallel tests never share memory layers.
    globalKey: Symbol("test.persistent-dedupe"),
    ttlMs: params?.ttlMs ?? 60_000,
    maxSize: params?.maxSize ?? 100,
    persistent: {
      namespace: "test.persistent-dedupe",
      maxEntries: params?.persistentMaxEntries ?? 100,
      openStore: params?.openStore ?? (() => backing.store),
      logError: params?.logError,
      readTimestamp: params?.readTimestamp,
    },
  });
  return { cache, backing };
}

describe("createPersistentDedupeCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records presence in both layers and answers from memory first", async () => {
    const { cache, backing } = createCache();
    await cache.register("k1", { at: 1 });
    expect(cache.peek("k1")).toBe(true);
    expect(await cache.lookup("k1")).toBe(true);
    expect(backing.store.register).toHaveBeenCalledWith("k1", { at: 1 });
    expect(backing.store.lookup).not.toHaveBeenCalled();
  });

  it.each([0, -1])("omits the persistent TTL when ttlMs is %i", async (ttlMs) => {
    const openStore = vi.fn(() => createMemoryStore().store);
    const { cache } = createCache({ ttlMs, openStore });

    await cache.register("non-expiring", { at: 1 });

    expect(openStore).toHaveBeenCalledWith({
      namespace: "test.persistent-dedupe",
      maxEntries: 100,
    });
  });

  it("forwards positive persistent TTLs without changing capacity", async () => {
    const openStore = vi.fn(() => createMemoryStore().store);
    const { cache } = createCache({ ttlMs: 60_000, persistentMaxEntries: 3, openStore });

    await cache.register("expiring", { at: 1 });

    expect(openStore).toHaveBeenCalledWith({
      namespace: "test.persistent-dedupe",
      maxEntries: 3,
      defaultTtlMs: 60_000,
    });
  });

  it("falls back to persistence and re-primes memory on a hit", async () => {
    const { cache, backing } = createCache();
    backing.entries.set("k2", { at: 42 });
    expect(cache.peek("k2")).toBe(false);
    expect(await cache.lookup("k2")).toBe(true);
    expect(cache.peek("k2")).toBe(true);
  });

  it("re-primes memory with the persisted timestamp when provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { cache, backing } = createCache({ readTimestamp: (record) => record.at });
    backing.entries.set("k3", { at: 1_000_000 - 59_000 });
    expect(await cache.lookup("k3")).toBe(true);
    // Re-primed at the original timestamp: expires 59s later instead of a fresh 60s TTL.
    vi.setSystemTime(1_000_000 + 2_000);
    expect(cache.peek("k3")).toBe(false);
  });

  it("keeps legacy persistent expirations authoritative in non-expiring memory", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const backing = createMemoryStore();
    const record = { at: Date.now() };
    const expiresAt = Date.now() + 60_000;
    backing.entries.set("legacy", record);
    const store = {
      ...backing.store,
      lookup: vi.fn(async (key: string) =>
        Date.now() < expiresAt ? backing.entries.get(key) : undefined,
      ),
      entries: vi.fn(async () => [
        { key: "legacy", value: record, createdAt: record.at, expiresAt },
      ]),
    };
    const { cache } = createCache({ ttlMs: 0, openStore: () => store });

    expect(await cache.lookup("legacy")).toBe(true);
    expect(cache.peek("legacy")).toBe(false);

    vi.setSystemTime(expiresAt);
    expect(await cache.lookup("legacy")).toBe(false);
    expect(cache.peek("legacy")).toBe(false);
    expect(store.lookup).toHaveBeenCalledTimes(2);
  });

  it("re-primes non-expiring memory only for durable persistent entries", async () => {
    const backing = createMemoryStore();
    const record = { at: 1_000_000 };
    backing.entries.set("durable", record);
    const store = {
      ...backing.store,
      entries: vi.fn(async () => [{ key: "durable", value: record, createdAt: record.at }]),
    };
    const { cache } = createCache({ ttlMs: 0, openStore: () => store });

    expect(await cache.lookup("durable")).toBe(true);
    expect(cache.peek("durable")).toBe(true);
    expect(await cache.lookup("durable")).toBe(true);
    expect(store.lookup).toHaveBeenCalledOnce();
  });

  it("rejects a persistent hit that disappears before its expiration metadata is read", async () => {
    const backing = createMemoryStore();
    backing.entries.set("missing", { at: 1_000_000 });
    const store = {
      ...backing.store,
      entries: vi.fn(async () => []),
    };
    const { cache } = createCache({ ttlMs: 0, openStore: () => store });

    expect(await cache.lookup("missing")).toBe(false);
    expect(cache.peek("missing")).toBe(false);
  });

  it("re-primes non-expiring memory when entry metadata is unavailable", async () => {
    const backing = createMemoryStore();
    backing.entries.set("durable", { at: 1_000_000 });
    const store = {
      ...backing.store,
      entries: vi.fn(async () => undefined),
    };
    const { cache } = createCache({ ttlMs: 0, openStore: () => store });

    expect(await cache.lookup("durable")).toBe(true);
    expect(cache.peek("durable")).toBe(true);
  });

  it("disables persistence after an expiration metadata read fails", async () => {
    const logError = vi.fn();
    const backing = createMemoryStore();
    backing.entries.set("legacy", { at: 1_000_000 });
    const error = new Error("metadata read failed");
    const store = {
      ...backing.store,
      entries: vi.fn(async () => {
        throw error;
      }),
    };
    const { cache } = createCache({ ttlMs: 0, openStore: () => store, logError });

    expect(await cache.lookup("legacy")).toBe(false);
    expect(cache.peek("legacy")).toBe(false);
    expect(logError).toHaveBeenCalledExactlyOnceWith(error);
    await cache.register("later", { at: 1_000_001 });
    expect(store.register).not.toHaveBeenCalled();
    expect(store.entries).toHaveBeenCalledOnce();
  });

  it("does not inspect expiration metadata for positive-TTL caches", async () => {
    const backing = createMemoryStore();
    backing.entries.set("expiring", { at: 1_000_000 });
    const store = {
      ...backing.store,
      entries: vi.fn(async () => []),
    };
    const { cache } = createCache({ ttlMs: 60_000, openStore: () => store });

    expect(await cache.lookup("expiring")).toBe(true);
    expect(cache.peek("expiring")).toBe(true);
    expect(store.entries).not.toHaveBeenCalled();
  });

  it("retains non-expiring entries past 24 hours and restores them after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { cache, backing } = createCache({ ttlMs: 0, readTimestamp: (record) => record.at });

    await cache.register("durable", { at: Date.now() }, { at: Date.now() });
    vi.setSystemTime(1_000_000 + 25 * 60 * 60 * 1000);
    expect(cache.peek("durable")).toBe(true);

    const { cache: restarted } = createCache({
      ttlMs: 0,
      openStore: () => backing.store,
      readTimestamp: (record) => record.at,
    });
    expect(restarted.peek("durable")).toBe(false);
    expect(await restarted.lookup("durable")).toBe(true);
    expect(restarted.peek("durable")).toBe(true);

    restarted.clearForTest();
    expect(restarted.peek("durable")).toBe(false);
    expect(await restarted.lookup("durable")).toBe(true);
    expect(backing.store.lookup).toHaveBeenCalledTimes(2);
  });

  it("deterministically evicts the oldest non-expiring memory entry at capacity", async () => {
    const { cache } = createCache({ ttlMs: 0, maxSize: 2, openStore: () => undefined });

    await cache.register("oldest", { at: 1 }, { at: 1 });
    await cache.register("retained", { at: 2 }, { at: 2 });
    await cache.register("newest", { at: 3 }, { at: 3 });

    expect(cache.peek("oldest")).toBe(false);
    expect(cache.peek("retained")).toBe(true);
    expect(cache.peek("newest")).toBe(true);
  });

  it("disables persistence after an open failure and never rejects", async () => {
    const logError = vi.fn();
    const openStore = vi.fn(() => {
      throw new Error("sqlite unavailable");
    });
    const { cache } = createCache({ openStore, logError });
    await expect(cache.register("k4", { at: 1 })).resolves.toBeUndefined();
    expect(cache.peek("k4")).toBe(true);
    expect(await cache.lookup("k5")).toBe(false);
    expect(openStore).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("disables persistence after a lookup failure", async () => {
    const logError = vi.fn();
    const store = {
      register: vi.fn(async () => {}),
      lookup: vi.fn(async () => {
        throw new Error("read failed");
      }),
    };
    const { cache } = createCache({ openStore: () => store, logError });
    expect(await cache.lookup("k6")).toBe(false);
    expect(logError).toHaveBeenCalledTimes(1);
    await cache.register("k7", { at: 1 });
    expect(store.register).not.toHaveBeenCalled();
  });

  it("clearForTest resets memory and re-enables persistence", async () => {
    const openStore = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementation(() => createMemoryStore().store);
    const { cache } = createCache({ openStore });
    await cache.register("k8", { at: 1 });
    cache.clearForTest();
    expect(cache.peek("k8")).toBe(false);
    await cache.register("k9", { at: 1 });
    expect(openStore).toHaveBeenCalledTimes(2);
  });
});
