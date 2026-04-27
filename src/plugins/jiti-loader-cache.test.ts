import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("jiti");
});

async function loadCachedPluginJitiLoader(scope: string) {
  const createJiti = vi.fn((filename: string, options?: Record<string, unknown>) =>
    Object.assign(vi.fn(), {
      filename,
      options,
    }),
  );
  vi.doMock("jiti", () => ({
    createJiti,
  }));

  const { getCachedPluginJitiLoader } = await importFreshModule<
    typeof import("./jiti-loader-cache.js")
  >(import.meta.url, `./jiti-loader-cache.js?scope=${scope}`);

  return { createJiti, getCachedPluginJitiLoader };
}

describe("getCachedPluginJitiLoader", () => {
  it("reuses cached loaders for the same module config and filename", async () => {
    const { createJiti, getCachedPluginJitiLoader } =
      await loadCachedPluginJitiLoader("cached-loader");

    const cache = new Map();
    const params = {
      cache,
      modulePath: "/repo/extensions/demo/index.ts",
      importerUrl: "file:///repo/src/plugins/setup-registry.ts",
      argvEntry: "/repo/openclaw.mjs",
      jitiFilename: "file:///repo/src/plugins/source-loader.ts",
    } as const;

    const first = getCachedPluginJitiLoader(params);
    const second = getCachedPluginJitiLoader(params);

    expect(second).toBe(first);
    expect(createJiti).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it("keeps loader caches scoped by jiti filename and dist preference", async () => {
    const { createJiti, getCachedPluginJitiLoader } =
      await loadCachedPluginJitiLoader("filename-scope");

    const cache = new Map();
    const first = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.ts",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      argvEntry: "/repo/openclaw.mjs",
      preferBuiltDist: true,
      jitiFilename: "file:///repo/src/plugins/public-surface-loader.ts",
    });
    const second = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.ts",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      argvEntry: "/repo/openclaw.mjs",
      preferBuiltDist: true,
      jitiFilename: "file:///repo/src/plugins/bundled-channel-config-metadata.ts",
    });

    expect(second).not.toBe(first);
    expect(createJiti).toHaveBeenNthCalledWith(
      1,
      "file:///repo/src/plugins/public-surface-loader.ts",
      expect.objectContaining({
        tryNative: false,
        interopDefault: true,
        alias: expect.any(Object),
      }),
    );
    expect(createJiti).toHaveBeenNthCalledWith(
      2,
      "file:///repo/src/plugins/bundled-channel-config-metadata.ts",
      expect.objectContaining({
        tryNative: false,
        interopDefault: true,
        alias: expect.any(Object),
      }),
    );
    expect(cache.size).toBe(2);
  });

  it("lets callers override alias maps and tryNative while keeping cache keys stable", async () => {
    const { createJiti, getCachedPluginJitiLoader } = await loadCachedPluginJitiLoader("overrides");

    const cache = new Map();
    const first = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/extensions/demo/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      jitiFilename: "file:///repo/src/plugins/loader.ts",
      aliasMap: {
        alpha: "/repo/alpha.js",
        zeta: "/repo/zeta.js",
      },
      tryNative: false,
    });
    const second = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/extensions/demo/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      jitiFilename: "file:///repo/src/plugins/loader.ts",
      aliasMap: {
        zeta: "/repo/zeta.js",
        alpha: "/repo/alpha.js",
      },
      tryNative: false,
    });

    expect(second).toBe(first);
    expect(createJiti).toHaveBeenCalledTimes(1);
    expect(createJiti).toHaveBeenCalledWith(
      "file:///repo/src/plugins/loader.ts",
      expect.objectContaining({
        tryNative: false,
        alias: {
          alpha: "/repo/alpha.js",
          zeta: "/repo/zeta.js",
        },
      }),
    );
  });

  it("lets callers intentionally share loaders behind a custom cache scope key", async () => {
    const { createJiti, getCachedPluginJitiLoader } =
      await loadCachedPluginJitiLoader("cache-scope-key");

    const cache = new Map();
    const first = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo-a/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      jitiFilename: "file:///repo/src/plugins/public-surface-loader.ts",
      aliasMap: {
        demo: "/repo/demo-a.js",
      },
      tryNative: true,
      cacheScopeKey: "bundled:native",
    });
    const second = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo-b/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      jitiFilename: "file:///repo/src/plugins/public-surface-loader.ts",
      aliasMap: {
        demo: "/repo/demo-b.js",
      },
      tryNative: true,
      cacheScopeKey: "bundled:native",
    });

    expect(second).toBe(first);
    expect(createJiti).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it("reuses pre-normalized alias options across module-scoped loader filenames", async () => {
    const { createJiti, getCachedPluginJitiLoader } =
      await loadCachedPluginJitiLoader("module-filename-aliases");

    const cache = new Map();
    getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/extensions/demo-a/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      jitiFilename: "/repo/extensions/demo-a/index.ts",
      aliasMap: {
        alpha: "/repo/alpha",
        beta: "alpha/sub",
      },
      tryNative: false,
    });
    getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/extensions/demo-b/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      jitiFilename: "/repo/extensions/demo-b/index.ts",
      aliasMap: {
        beta: "alpha/sub",
        alpha: "/repo/alpha",
      },
      tryNative: false,
    });

    const marker = Symbol.for("pathe:normalizedAlias");
    const firstAlias = (createJiti.mock.calls[0]?.[1] as { alias?: Record<string, string> }).alias;
    const secondAlias = (createJiti.mock.calls[1]?.[1] as { alias?: Record<string, string> }).alias;

    expect(createJiti).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
    expect(secondAlias).toBe(firstAlias);
    expect(firstAlias?.beta).toBe("/repo/alpha/sub");
    expect((firstAlias as Record<symbol, unknown>)[marker]).toBe(true);
  });

  it("serves compiled .js targets from native require without invoking the jiti loader", async () => {
    const jitiLoader = vi.fn();
    const createJiti = vi.fn(() => jitiLoader);
    vi.doMock("jiti", () => ({ createJiti }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: (p: string) =>
        p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs"),
      tryNativeRequireJavaScriptModule: (target: string) => ({
        ok: true,
        moduleExport: { loadedFrom: target },
      }),
    }));
    const { getCachedPluginJitiLoader } = await importFreshModule<
      typeof import("./jiti-loader-cache.js")
    >(import.meta.url, "./jiti-loader-cache.js?scope=native-require-fastpath");

    const cache = new Map();
    const loader = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      jitiFilename: "file:///repo/src/plugins/public-surface-loader.ts",
    });

    const result = loader("/repo/dist/extensions/demo/api.js") as { loadedFrom: string };
    expect(result.loadedFrom).toBe("/repo/dist/extensions/demo/api.js");
    // jiti is created eagerly, but its loader must NOT be invoked for .js
    // targets that `tryNativeRequireJavaScriptModule` resolves.
    expect(jitiLoader).not.toHaveBeenCalled();
  });

  it("falls back to jiti when the native-require helper declines", async () => {
    const jitiLoader = vi.fn(() => ({ fromJiti: true }));
    const createJiti = vi.fn(() => jitiLoader);
    vi.doMock("jiti", () => ({ createJiti }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: () => ({ ok: false }),
    }));
    const { getCachedPluginJitiLoader } = await importFreshModule<
      typeof import("./jiti-loader-cache.js")
    >(import.meta.url, "./jiti-loader-cache.js?scope=native-require-fallback");

    const cache = new Map();
    const loader = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      jitiFilename: "file:///repo/src/plugins/public-surface-loader.ts",
    });

    const result = loader("/repo/dist/extensions/demo/api.js") as { fromJiti: boolean };
    expect(result.fromJiti).toBe(true);
    expect(jitiLoader).toHaveBeenCalledWith("/repo/dist/extensions/demo/api.js");
  });

  it("skips the native-require fast path when tryNative is explicitly false", async () => {
    const jitiLoader = vi.fn(() => ({ fromJiti: true }));
    const createJiti = vi.fn(() => jitiLoader);
    vi.doMock("jiti", () => ({ createJiti }));
    const nativeStub = vi.fn(() => ({ ok: true, moduleExport: { fromNative: true } }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: nativeStub,
    }));
    const { getCachedPluginJitiLoader } = await importFreshModule<
      typeof import("./jiti-loader-cache.js")
    >(import.meta.url, "./jiti-loader-cache.js?scope=native-require-opt-out");

    const cache = new Map();
    const loader = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugins/bundled-capability-runtime.ts",
      jitiFilename: "file:///repo/src/plugins/bundled-capability-runtime.ts",
      aliasMap: { "openclaw/plugin-sdk": "/repo/shim.js" },
      tryNative: false,
    });

    const result = loader("/repo/dist/extensions/demo/api.js") as { fromJiti: boolean };
    expect(result.fromJiti).toBe(true);
    // With tryNative: false the wrapper must route every target through jiti
    // so its alias rewrites still apply; native require must not be consulted.
    expect(nativeStub).not.toHaveBeenCalled();
    expect(jitiLoader).toHaveBeenCalledWith("/repo/dist/extensions/demo/api.js");
  });

  it("forwards extra loader arguments through to the jiti fallback", async () => {
    const jitiLoader = vi.fn(() => ({ fromJiti: true }));
    const createJiti = vi.fn(() => jitiLoader);
    vi.doMock("jiti", () => ({ createJiti }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: () => ({ ok: false }),
    }));
    const { getCachedPluginJitiLoader } = await importFreshModule<
      typeof import("./jiti-loader-cache.js")
    >(import.meta.url, "./jiti-loader-cache.js?scope=native-require-rest-args");

    const cache = new Map();
    const loader = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      jitiFilename: "file:///repo/src/plugins/public-surface-loader.ts",
    });

    const loose = loader as unknown as (t: string, ...a: unknown[]) => unknown;
    loose("/repo/dist/extensions/demo/api.js", { hint: "x" }, 42);
    expect(jitiLoader).toHaveBeenCalledWith("/repo/dist/extensions/demo/api.js", { hint: "x" }, 42);
  });
});
