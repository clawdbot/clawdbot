// Lazy promise tests cover single-flight loading and error reuse behavior.
import { describe, expect, it, vi } from "vitest";
import {
  createLazyImportLoader,
  createLazyPromise,
  createLazyPromiseLoader,
  getOrCreatePromise,
} from "./lazy-promise.js";

describe("getOrCreatePromise", () => {
  it("dedupes each key and leaves cache lifecycle to the caller", async () => {
    const cache = new Map<string, Promise<string>>();
    const create = vi.fn(async (key: string) => `loaded-${key}`);

    const first = getOrCreatePromise(cache, "a", async () => await create("a"));
    expect(getOrCreatePromise(cache, "a", async () => await create("a"))).toBe(first);
    await expect(first).resolves.toBe("loaded-a");
    await expect(getOrCreatePromise(cache, "b", async () => await create("b"))).resolves.toBe(
      "loaded-b",
    );
    expect(create).toHaveBeenCalledTimes(2);

    cache.clear();
    await expect(getOrCreatePromise(cache, "a", async () => await create("a"))).resolves.toBe(
      "loaded-a",
    );
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("keeps rejected loads cached by default", async () => {
    const cache = new Map<string, Promise<string>>();
    const create = vi.fn(async () => {
      throw new Error("sticky");
    });

    const first = getOrCreatePromise(cache, "a", create);
    await expect(first).rejects.toThrow("sticky");
    expect(getOrCreatePromise(cache, "a", create)).toBe(first);
    expect(create).toHaveBeenCalledOnce();
  });

  it("evicts only rejected loads when rejection caching is disabled", async () => {
    const cache = new Map<string, Promise<string>>();
    const create = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("recovered");

    await expect(
      getOrCreatePromise(cache, "a", create, { cacheRejections: false }),
    ).rejects.toThrow("transient");
    await expect(getOrCreatePromise(cache, "a", create, { cacheRejections: false })).resolves.toBe(
      "recovered",
    );
    await expect(getOrCreatePromise(cache, "a", create, { cacheRejections: false })).resolves.toBe(
      "recovered",
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("evicts settled in-flight work without deleting a replacement", async () => {
    const cache = new Map<string, Promise<string>>();
    let resolveFirst!: (value: string) => void;
    const first = getOrCreatePromise(
      cache,
      "a",
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
      { evictOnSettled: true },
    );
    const replacement = Promise.resolve("replacement");
    cache.set("a", replacement);

    resolveFirst("first");
    await expect(first).resolves.toBe("first");
    expect(cache.get("a")).toBe(replacement);

    await expect(
      getOrCreatePromise(cache, "b", async () => "settled", { evictOnSettled: true }),
    ).resolves.toBe("settled");
    expect(cache.has("b")).toBe(false);
  });

  it("does not let a stale rejection delete a replacement", async () => {
    const cache = new Map<string, Promise<string>>();
    let rejectFirst!: (reason: Error) => void;
    const first = getOrCreatePromise(
      cache,
      "a",
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectFirst = reject;
        }),
      { cacheRejections: false },
    );
    const replacement = Promise.resolve("replacement");
    cache.set("a", replacement);

    rejectFirst(new Error("stale"));
    await expect(first).rejects.toThrow("stale");
    expect(cache.get("a")).toBe(replacement);
  });
});

describe("createLazyPromise", () => {
  it("returns a reusable single-flight loader", async () => {
    let calls = 0;
    const load = createLazyPromise(async () => `loaded-${++calls}`);

    await expect(Promise.all([load(), load()])).resolves.toEqual(["loaded-1", "loaded-1"]);
    await expect(load()).resolves.toBe("loaded-1");
    expect(calls).toBe(1);
  });
});

describe("createLazyPromiseLoader", () => {
  it("dedupes concurrent loads and reuses the resolved value", async () => {
    let calls = 0;
    const loader = createLazyPromiseLoader(async () => `loaded-${++calls}`);
    const first = loader.load();

    expect(loader.load()).toBe(first);
    await expect(first).resolves.toBe("loaded-1");
    await expect(loader.load()).resolves.toBe("loaded-1");
    expect(calls).toBe(1);
  });

  it("evicts rejected loads by default so retries can recover", async () => {
    let calls = 0;
    const loader = createLazyPromiseLoader(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient");
      }
      return "recovered";
    });

    await expect(loader.load()).rejects.toThrow("transient");
    await expect(loader.load()).resolves.toBe("recovered");
    expect(calls).toBe(2);
  });

  it("can keep rejected loads when requested", async () => {
    const load = vi.fn(async () => {
      throw new Error("sticky");
    });
    const loader = createLazyPromiseLoader(load, { cacheRejections: true });

    await expect(loader.load()).rejects.toThrow("sticky");
    await expect(loader.load()).rejects.toThrow("sticky");
    expect(load).toHaveBeenCalledOnce();
  });

  it("clears cached values", async () => {
    let calls = 0;
    const loader = createLazyPromiseLoader(() => `loaded-${++calls}`);

    expect(loader.peek()).toBeUndefined();
    await expect(loader.load()).resolves.toBe("loaded-1");
    await expect(loader.peek()).resolves.toBe("loaded-1");
    loader.clear();
    expect(loader.peek()).toBeUndefined();
    await expect(loader.load()).resolves.toBe("loaded-2");
  });
});

describe("createLazyImportLoader", () => {
  it("wraps import-shaped loaders", async () => {
    const loader = createLazyImportLoader(async () => ({ value: "module" }));

    await expect(loader.load()).resolves.toEqual({ value: "module" });
  });
});
