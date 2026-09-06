/** Tests primitive cache-key helpers used by plugin descriptor and metadata caches. */
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginLruCache, createConfigScopedPromiseLoader } from "./plugin-cache-primitives.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

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

  it("distinguishes cached null values from misses", () => {
    const cache = new PluginLruCache<string | null>(2);

    cache.set("missing", null);

    expect(cache.get("missing")).toBeNull();
    expect(cache.get("unknown")).toBeUndefined();
  });
});

describe("createConfigScopedPromiseLoader", () => {
  it("dedupes concurrent default loads", async () => {
    let calls = 0;
    const loader = createConfigScopedPromiseLoader(async () => `loaded-${++calls}`);

    await expect(Promise.all([loader.load(), loader.load()])).resolves.toEqual([
      "loaded-1",
      "loaded-1",
    ]);
    await expect(loader.load()).resolves.toBe("loaded-1");
    expect(calls).toBe(1);
  });

  it("caches loads by config object", async () => {
    const firstConfig = { plugins: { load: { disabled: true } } } as OpenClawConfig;
    const secondConfig = { plugins: { load: { disabled: false } } } as OpenClawConfig;
    const load = vi.fn(async (config?: OpenClawConfig) =>
      config === firstConfig ? "first" : "second",
    );
    const loader = createConfigScopedPromiseLoader(load);

    await expect(loader.load(firstConfig)).resolves.toBe("first");
    await expect(loader.load(firstConfig)).resolves.toBe("first");
    await expect(loader.load(secondConfig)).resolves.toBe("second");

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("evicts rejected loads so retries can recover", async () => {
    const config = {} as OpenClawConfig;
    let calls = 0;
    const loader = createConfigScopedPromiseLoader(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient");
      }
      return "recovered";
    });

    await expect(loader.load(config)).rejects.toThrow("transient");
    await expect(loader.load(config)).resolves.toBe("recovered");
    expect(calls).toBe(2);
  });

  it.each([
    { name: "config-scoped", config: {} as OpenClawConfig },
    { name: "default", config: undefined },
  ])("keeps the refreshed $name promise when a retired generation rejects", async ({ config }) => {
    const retired = createDeferred<string>();
    let calls = 0;
    const loader = createConfigScopedPromiseLoader(() => {
      calls += 1;
      return calls === 1 ? retired.promise : Promise.resolve(`fresh-${calls}`);
    });

    const stale = loader.load(config);
    const staleFailure = expect(stale).rejects.toThrow("retired generation");
    await Promise.resolve();

    clearPluginMetadataLifecycleCaches();

    await expect(loader.load(config)).resolves.toBe("fresh-2");
    retired.reject(new Error("retired generation"));
    await staleFailure;

    await expect(loader.load(config)).resolves.toBe("fresh-2");
    expect(calls).toBe(2);
  });

  it("clears default and config-scoped entries", async () => {
    const config = {} as OpenClawConfig;
    let calls = 0;
    const loader = createConfigScopedPromiseLoader(
      async (owner?: OpenClawConfig) => `${owner ? "config" : "default"}-${++calls}`,
    );

    await expect(loader.load()).resolves.toBe("default-1");
    await expect(loader.load(config)).resolves.toBe("config-2");

    loader.clear();

    await expect(loader.load()).resolves.toBe("default-3");
    await expect(loader.load(config)).resolves.toBe("config-4");
  });

  it("drops default and config-scoped executable promises when plugin metadata changes", async () => {
    const config = {} as OpenClawConfig;
    let calls = 0;
    const loader = createConfigScopedPromiseLoader(
      async (owner?: OpenClawConfig) => `${owner ? "config" : "default"}-${++calls}`,
    );

    await expect(loader.load()).resolves.toBe("default-1");
    await expect(loader.load(config)).resolves.toBe("config-2");

    clearPluginMetadataLifecycleCaches();

    await expect(loader.load()).resolves.toBe("default-3");
    await expect(loader.load(config)).resolves.toBe("config-4");
  });
});
