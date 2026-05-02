import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("jiti");
});

async function loadCachedPluginModuleLoader(scope: string) {
  const createJiti = vi.fn((filename: string, options?: Record<string, unknown>) =>
    Object.assign(vi.fn(), {
      filename,
      options,
    }),
  );
  vi.doMock("jiti", () => ({
    createJiti,
  }));

  const { getCachedPluginModuleLoader } = await importFreshModule<
    typeof import("./plugin-module-loader-cache.js")
  >(import.meta.url, `./plugin-module-loader-cache.js?scope=${scope}`);

  return { createJiti, getCachedPluginModuleLoader };
}

describe("getCachedPluginModuleLoader", () => {
  it("resolves deterministic cache entries for equivalent alias maps", async () => {
    const { resolvePluginModuleLoaderCacheEntry } = await importFreshModule<
      typeof import("./plugin-module-loader-cache.js")
    >(import.meta.url, "./plugin-module-loader-cache.js?scope=cache-entry-alias-order");

    const first = resolvePluginModuleLoaderCacheEntry({
      modulePath: "/repo/extensions/demo/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      loaderFilename: "/repo/src/plugins/loader.ts",
      aliasMap: {
        alpha: "/repo/alpha.js",
        zeta: "/repo/zeta.js",
      },
      tryNative: false,
    });
    const second = resolvePluginModuleLoaderCacheEntry({
      modulePath: "/repo/extensions/demo/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      loaderFilename: "/repo/src/plugins/loader.ts",
      aliasMap: {
        zeta: "/repo/zeta.js",
        alpha: "/repo/alpha.js",
      },
      tryNative: false,
    });

    expect(second.cacheKey).toBe(first.cacheKey);
    expect(second.scopedCacheKey).toBe(first.scopedCacheKey);
    expect(first.loaderFilename).toBe("/repo/src/plugins/loader.ts");
  });

  it("keeps explicit shared cache scope keys independent of loader options", async () => {
    const { resolvePluginModuleLoaderCacheEntry } = await importFreshModule<
      typeof import("./plugin-module-loader-cache.js")
    >(import.meta.url, "./plugin-module-loader-cache.js?scope=cache-entry-shared-scope");

    const first = resolvePluginModuleLoaderCacheEntry({
      modulePath: "/repo/dist/extensions/demo-a/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      loaderFilename: "/repo/src/plugins/public-surface-loader.ts",
      aliasMap: { demo: "/repo/demo-a.js" },
      tryNative: true,
      sharedCacheScopeKey: "bundled:native",
    });
    const second = resolvePluginModuleLoaderCacheEntry({
      modulePath: "/repo/dist/extensions/demo-b/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      loaderFilename: "/repo/src/plugins/public-surface-loader.ts",
      aliasMap: { demo: "/repo/demo-b.js" },
      tryNative: false,
      sharedCacheScopeKey: "bundled:native",
    });

    expect(first.cacheKey).not.toBe(second.cacheKey);
    expect(first.scopedCacheKey).toBe(second.scopedCacheKey);
  });

  it("reuses cached loaders for the same module config and filename", async () => {
    const { createJiti, getCachedPluginModuleLoader } =
      await loadCachedPluginModuleLoader("cached-loader");

    const cache = new Map();
    const params = {
      cache,
      modulePath: "/repo/extensions/demo/index.ts",
      importerUrl: "file:///repo/src/plugins/setup-registry.ts",
      argvEntry: "/repo/openclaw.mjs",
      loaderFilename: "file:///repo/src/plugins/source-loader.ts",
    } as const;

    const first = getCachedPluginModuleLoader(params);
    const second = getCachedPluginModuleLoader(params);

    expect(second).toBe(first);
    first("/repo/extensions/demo/index.ts");
    expect(createJiti).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it("creates bounded loader caches", async () => {
    const { createJiti, getCachedPluginModuleLoader } =
      await loadCachedPluginModuleLoader("bounded-loader-cache");
    const { createPluginModuleLoaderCache } = await importFreshModule<
      typeof import("./plugin-module-loader-cache.js")
    >(import.meta.url, "./plugin-module-loader-cache.js?scope=bounded-loader-cache-factory");

    const cache = createPluginModuleLoaderCache(1);
    const first = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/extensions/demo-a/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      loaderFilename: "/repo/extensions/demo-a/index.ts",
    });
    getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/extensions/demo-b/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      loaderFilename: "/repo/extensions/demo-b/index.ts",
    });
    const reloadedFirst = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/extensions/demo-a/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      loaderFilename: "/repo/extensions/demo-a/index.ts",
    });

    expect(cache.size).toBe(1);
    expect(reloadedFirst).not.toBe(first);
    reloadedFirst("/repo/extensions/demo-a/index.ts");
    expect(createJiti).toHaveBeenCalledOnce();
  });

  it("keeps loader caches scoped by loader filename and dist preference", async () => {
    const { createJiti, getCachedPluginModuleLoader } =
      await loadCachedPluginModuleLoader("filename-scope");

    const cache = new Map();
    const first = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.ts",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      argvEntry: "/repo/openclaw.mjs",
      preferBuiltDist: true,
      loaderFilename: "file:///repo/src/plugins/public-surface-loader.ts",
    });
    const second = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.ts",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      argvEntry: "/repo/openclaw.mjs",
      preferBuiltDist: true,
      loaderFilename: "file:///repo/src/plugins/bundled-channel-config-metadata.ts",
    });

    expect(second).not.toBe(first);
    first("/repo/dist/extensions/demo/api.ts");
    second("/repo/dist/extensions/demo/api.ts");
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
    const { createJiti, getCachedPluginModuleLoader } =
      await loadCachedPluginModuleLoader("overrides");

    const cache = new Map();
    const first = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/extensions/demo/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      loaderFilename: "file:///repo/src/plugins/loader.ts",
      aliasMap: {
        alpha: "/repo/alpha.js",
        zeta: "/repo/zeta.js",
      },
      tryNative: false,
    });
    const second = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/extensions/demo/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      loaderFilename: "file:///repo/src/plugins/loader.ts",
      aliasMap: {
        zeta: "/repo/zeta.js",
        alpha: "/repo/alpha.js",
      },
      tryNative: false,
    });

    expect(second).toBe(first);
    first("/repo/extensions/demo/index.ts");
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

  it("keeps cache scope keys separated by loader options", async () => {
    const { createJiti, getCachedPluginModuleLoader } =
      await loadCachedPluginModuleLoader("cache-scope-key");

    const cache = new Map();
    const first = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo-a/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      loaderFilename: "file:///repo/src/plugins/public-surface-loader.ts",
      aliasMap: {
        demo: "/repo/demo-a.js",
      },
      tryNative: true,
      cacheScopeKey: "bundled:native",
    });
    const second = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo-b/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      loaderFilename: "file:///repo/src/plugins/public-surface-loader.ts",
      aliasMap: {
        demo: "/repo/demo-b.js",
      },
      tryNative: true,
      cacheScopeKey: "bundled:native",
    });

    expect(second).not.toBe(first);
    first("/repo/dist/extensions/demo-a/api.js");
    second("/repo/dist/extensions/demo-b/api.js");
    expect(createJiti).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
  });

  it("lets callers explicitly share loaders behind an unsafe shared cache scope key", async () => {
    const { createJiti, getCachedPluginModuleLoader } =
      await loadCachedPluginModuleLoader("shared-cache-scope-key");

    const cache = new Map();
    const first = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo-a/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      loaderFilename: "file:///repo/src/plugins/public-surface-loader.ts",
      aliasMap: {
        demo: "/repo/demo-a.js",
      },
      tryNative: true,
      sharedCacheScopeKey: "bundled:native",
    });
    const second = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo-b/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      loaderFilename: "file:///repo/src/plugins/public-surface-loader.ts",
      aliasMap: {
        demo: "/repo/demo-b.js",
      },
      tryNative: true,
      sharedCacheScopeKey: "bundled:native",
    });

    expect(second).toBe(first);
    second("/repo/dist/extensions/demo-b/api.js");
    expect(createJiti).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it("reuses pre-normalized alias options across module-scoped loader filenames", async () => {
    const { createJiti, getCachedPluginModuleLoader } =
      await loadCachedPluginModuleLoader("module-filename-aliases");

    const cache = new Map();
    getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/extensions/demo-a/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      loaderFilename: "/repo/extensions/demo-a/index.ts",
      aliasMap: {
        alpha: "/repo/alpha",
        beta: "alpha/sub",
      },
      tryNative: false,
    });
    getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/extensions/demo-b/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      loaderFilename: "/repo/extensions/demo-b/index.ts",
      aliasMap: {
        beta: "alpha/sub",
        alpha: "/repo/alpha",
      },
      tryNative: false,
    });

    getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/extensions/demo-a/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      loaderFilename: "/repo/extensions/demo-a/index.ts",
      aliasMap: {
        alpha: "/repo/alpha",
        beta: "alpha/sub",
      },
      tryNative: false,
    })("/repo/extensions/demo-a/index.ts");
    getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/extensions/demo-b/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      loaderFilename: "/repo/extensions/demo-b/index.ts",
      aliasMap: {
        beta: "alpha/sub",
        alpha: "/repo/alpha",
      },
      tryNative: false,
    })("/repo/extensions/demo-b/index.ts");

    const marker = Symbol.for("pathe:normalizedAlias");
    const firstAlias = (createJiti.mock.calls[0]?.[1] as { alias?: Record<string, string> }).alias;
    const secondAlias = (createJiti.mock.calls[1]?.[1] as { alias?: Record<string, string> }).alias;

    expect(createJiti).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
    expect(secondAlias).toBe(firstAlias);
    expect(firstAlias?.beta).toBe("/repo/alpha/sub");
    expect((firstAlias as Record<symbol, unknown>)[marker]).toBe(true);
  });

  it("serves compiled .js targets from native require without invoking the module loader", async () => {
    const fromSourceTransformer = vi.fn();
    const createJiti = vi.fn(() => fromSourceTransformer);
    vi.doMock("jiti", () => ({ createJiti }));
    const nativeStub = vi.fn((target: string) => ({
      ok: true as const,
      moduleExport: { loadedFrom: target },
    }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: (p: string) =>
        p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs"),
      tryNativeRequireJavaScriptModule: nativeStub,
    }));
    const { getCachedPluginModuleLoader } = await importFreshModule<
      typeof import("./plugin-module-loader-cache.js")
    >(import.meta.url, "./plugin-module-loader-cache.js?scope=native-require-fastpath");

    const cache = new Map();
    const loader = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      loaderFilename: "file:///repo/src/plugins/public-surface-loader.ts",
    });

    const result = loader("/repo/dist/extensions/demo/api.js") as { loadedFrom: string };
    expect(result.loadedFrom).toBe("/repo/dist/extensions/demo/api.js");
    // Jiti should not be constructed or invoked for .js targets that
    // `tryNativeRequireJavaScriptModule` resolves.
    expect(createJiti).not.toHaveBeenCalled();
    expect(fromSourceTransformer).not.toHaveBeenCalled();
    // allowWindows must be passed so the native fast path works on Windows too.
    expect(nativeStub).toHaveBeenCalledWith("/repo/dist/extensions/demo/api.js", {
      allowWindows: true,
    });
  });

  it("falls back to source transform when the native-require helper declines", async () => {
    const fromSourceTransformer = vi.fn(() => ({ fromSourceTransform: true }));
    const createJiti = vi.fn(() => fromSourceTransformer);
    vi.doMock("jiti", () => ({ createJiti }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: () => ({ ok: false }),
    }));
    const { getCachedPluginModuleLoader } = await importFreshModule<
      typeof import("./plugin-module-loader-cache.js")
    >(import.meta.url, "./plugin-module-loader-cache.js?scope=native-require-fallback");

    const cache = new Map();
    const loader = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      loaderFilename: "file:///repo/src/plugins/public-surface-loader.ts",
    });

    const result = loader("/repo/dist/extensions/demo/api.js") as { fromSourceTransform: boolean };
    expect(result.fromSourceTransform).toBe(true);
    expect(fromSourceTransformer).toHaveBeenCalledWith("/repo/dist/extensions/demo/api.js");
  });

  it("normalizes Windows absolute paths before creating and calling the source transformer", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const fromSourceTransformer = vi.fn(() => ({ fromSourceTransform: true }));
    const createJiti = vi.fn(() => fromSourceTransformer);
    vi.doMock("jiti", () => ({ createJiti }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: () => ({ ok: false }),
    }));
    const { getCachedPluginModuleLoader } = await importFreshModule<
      typeof import("./plugin-module-loader-cache.js")
    >(import.meta.url, "./plugin-module-loader-cache.js?scope=windows-jiti-paths");

    const cache = new Map();
    const loader = getCachedPluginModuleLoader({
      cache,
      modulePath: "C:\\Users\\alice\\openclaw\\dist\\extensions\\feishu\\api.js",
      importerUrl: "file:///C:/Users/alice/openclaw/dist/src/plugins/public-surface-loader.js",
      loaderFilename: "C:\\Users\\alice\\openclaw\\dist\\extensions\\feishu\\api.js",
      tryNative: true,
    });

    loader("C:\\Users\\alice\\openclaw\\dist\\extensions\\feishu\\api.js");

    expect(createJiti).toHaveBeenCalledWith(
      "file:///C:/Users/alice/openclaw/dist/extensions/feishu/api.js",
      expect.objectContaining({ tryNative: true }),
    );
    expect(fromSourceTransformer).toHaveBeenCalledWith(
      "file:///C:/Users/alice/openclaw/dist/extensions/feishu/api.js",
    );
  });

  it("skips the native-require fast path when tryNative is explicitly false", async () => {
    const fromSourceTransformer = vi.fn(() => ({ fromSourceTransform: true }));
    const createJiti = vi.fn(() => fromSourceTransformer);
    vi.doMock("jiti", () => ({ createJiti }));
    const nativeStub = vi.fn(() => ({ ok: true, moduleExport: { fromNative: true } }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: nativeStub,
    }));
    const { getCachedPluginModuleLoader } = await importFreshModule<
      typeof import("./plugin-module-loader-cache.js")
    >(import.meta.url, "./plugin-module-loader-cache.js?scope=native-require-opt-out");

    const cache = new Map();
    const loader = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugins/bundled-capability-runtime.ts",
      loaderFilename: "file:///repo/src/plugins/bundled-capability-runtime.ts",
      aliasMap: { "openclaw/plugin-sdk": "/repo/shim.js" },
      tryNative: false,
    });

    const result = loader("/repo/dist/extensions/demo/api.js") as { fromSourceTransform: boolean };
    expect(result.fromSourceTransform).toBe(true);
    // With tryNative: false the wrapper must route every target through the source transformer
    // so its alias rewrites still apply; native require must not be consulted.
    expect(nativeStub).not.toHaveBeenCalled();
    expect(fromSourceTransformer).toHaveBeenCalledWith("/repo/dist/extensions/demo/api.js");
  });

  it("normalizes Windows absolute paths when native loading is disabled", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const fromSourceTransformer = vi.fn(() => ({ fromSourceTransform: true }));
    const createJiti = vi.fn(() => fromSourceTransformer);
    vi.doMock("jiti", () => ({ createJiti }));
    const nativeStub = vi.fn(() => ({ ok: true, moduleExport: { fromNative: true } }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: nativeStub,
    }));
    const { getCachedPluginModuleLoader } = await importFreshModule<
      typeof import("./plugin-module-loader-cache.js")
    >(import.meta.url, "./plugin-module-loader-cache.js?scope=windows-jiti-no-native");

    const cache = new Map();
    const loader = getCachedPluginModuleLoader({
      cache,
      modulePath: "C:\\Users\\alice\\openclaw\\extensions\\feishu\\api.ts",
      importerUrl: "file:///C:/Users/alice/openclaw/src/plugins/loader.ts",
      loaderFilename: "C:\\Users\\alice\\openclaw\\extensions\\feishu\\api.ts",
      tryNative: false,
    });

    loader("C:\\Users\\alice\\openclaw\\extensions\\feishu\\api.ts");

    expect(nativeStub).not.toHaveBeenCalled();
    expect(createJiti).toHaveBeenCalledWith(
      "file:///C:/Users/alice/openclaw/extensions/feishu/api.ts",
      expect.objectContaining({ tryNative: false }),
    );
    expect(fromSourceTransformer).toHaveBeenCalledWith(
      "file:///C:/Users/alice/openclaw/extensions/feishu/api.ts",
    );
  });

  it("forwards extra loader arguments through to the source-transform fallback", async () => {
    const fromSourceTransformer = vi.fn(() => ({ fromSourceTransform: true }));
    const createJiti = vi.fn(() => fromSourceTransformer);
    vi.doMock("jiti", () => ({ createJiti }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: () => ({ ok: false }),
    }));
    const { getCachedPluginModuleLoader } = await importFreshModule<
      typeof import("./plugin-module-loader-cache.js")
    >(import.meta.url, "./plugin-module-loader-cache.js?scope=native-require-rest-args");

    const cache = new Map();
    const loader = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      loaderFilename: "file:///repo/src/plugins/public-surface-loader.ts",
    });

    const loose = loader as unknown as (t: string, ...a: unknown[]) => unknown;
    loose("/repo/dist/extensions/demo/api.js", { hint: "x" }, 42);
    expect(fromSourceTransformer).toHaveBeenCalledWith(
      "/repo/dist/extensions/demo/api.js",
      { hint: "x" },
      42,
    );
  });
});
