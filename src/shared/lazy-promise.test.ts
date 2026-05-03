import { describe, expect, it, vi } from "vitest";
import { createLazyImportLoader, createLazyPromiseLoader } from "./lazy-promise.js";

describe("createLazyPromiseLoader", () => {
  it("dedupes concurrent loads and reuses the resolved value", async () => {
    let calls = 0;
    const loader = createLazyPromiseLoader(async () => `loaded-${++calls}`);

    await expect(Promise.all([loader.load(), loader.load()])).resolves.toEqual([
      "loaded-1",
      "loaded-1",
    ]);
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

    await expect(loader.load()).resolves.toBe("loaded-1");
    loader.clear();
    await expect(loader.load()).resolves.toBe("loaded-2");
  });
});

describe("createLazyImportLoader", () => {
  it("wraps import-shaped loaders", async () => {
    const loader = createLazyImportLoader(async () => ({ value: "module" }));

    await expect(loader.load()).resolves.toEqual({ value: "module" });
  });
});
