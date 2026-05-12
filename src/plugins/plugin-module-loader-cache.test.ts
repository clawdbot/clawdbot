import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginModuleLoaderFactory } from "./plugin-module-loader-cache.js";

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

  const pluginModuleLoaderCache = await importFreshModule<
    typeof import("./plugin-module-loader-cache.js")
  >(import.meta.url, `./plugin-module-loader-cache.js?scope=${scope}`);
  const getCachedPluginModuleLoader: typeof pluginModuleLoaderCache.getCachedPluginModuleLoader = (
    params,
  ) =>
    pluginModuleLoaderCache.getCachedPluginModuleLoader({
      ...params,
      createLoader: params.createLoader ?? asPluginModuleLoaderFactory(createJiti),
    });

  return { createJiti, getCachedPluginModuleLoader };
}

function asPluginModuleLoaderFactory(factory: unknown): PluginModuleLoaderFactory {
  return factory as PluginModuleLoaderFactory;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function callArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  const call = calls.at(callIndex);
  if (!call) {
    throw new Error(`${label} call ${callIndex} was missing`);
  }
  return call[argIndex];
}

function expectJitiOptions(
  mock: unknown,
  callIndex: number,
  filename: string,
  fields: Record<string, unknown>,
) {
  expect(callArg(mock, callIndex, 0, "jiti filename")).toBe(filename);
  const options = requireRecord(callArg(mock, callIndex, 1, "jiti options"), "jiti options");
  for (const [key, expected] of Object.entries(fields)) {
    expect(options[key]).toBe(expected);
  }
  return options;
}

function expectNativeOptions(mock: unknown, target: string) {
  expect(callArg(mock, 0, 0, "native target")).toBe(target);
  const options = requireRecord(callArg(mock, 0, 1, "native options"), "native options");
  expect(options.allowWindows).toBe(true);
  expect(options.fallbackOnMissingDependency).toBe(true);
  expect(options.fallbackOnNativeError).toBe(true);
}

function expectStats(value: unknown, fields: Record<string, unknown>) {
  const stats = requireRecord(value, "loader stats");
  for (const [key, expected] of Object.entries(fields)) {
    expect(stats[key]).toEqual(expected);
  }
  return stats;
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
    const firstOptions = expectJitiOptions(
      createJiti,
      0,
      "file:///repo/src/plugins/public-surface-loader.ts",
      { tryNative: false, interopDefault: true },
    );
    expect(firstOptions.alias).toBeTypeOf("object");
    const secondOptions = expectJitiOptions(
      createJiti,
      1,
      "file:///repo/src/plugins/bundled-channel-config-metadata.ts",
      { tryNative: false, interopDefault: true },
    );
    expect(secondOptions.alias).toBeTypeOf("object");
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
    const options = expectJitiOptions(createJiti, 0, "file:///repo/src/plugins/loader.ts", {
      tryNative: false,
    });
    expect(options.alias).toEqual({
      alpha: "/repo/alpha.js",
      zeta: "/repo/zeta.js",
    });
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
    const firstAlias = (
      callArg(createJiti, 0, 1, "first jiti options") as {
        alias?: Record<string, string>;
      }
    ).alias;
    const secondAlias = (
      callArg(createJiti, 1, 1, "second jiti options") as {
        alias?: Record<string, string>;
      }
    ).alias;

    expect(createJiti).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
    expect(secondAlias).toBe(firstAlias);
    expect(firstAlias?.beta).toBe("/repo/alpha/sub");
    expect((firstAlias as Record<symbol, unknown>)[marker]).toBe(true);
  });

  it("serves compiled .js targets from native require without invoking the module loader", async () => {
    const fromSourceTransformer = vi.fn();
    const createJiti = vi.fn(() => fromSourceTransformer);
    const nativeStub = vi.fn((target: string) => ({
      ok: true as const,
      moduleExport: { loadedFrom: target },
    }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: (p: string) =>
        p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs"),
      tryNativeRequireJavaScriptModule: nativeStub,
    }));
    const { getCachedPluginModuleLoader, getPluginModuleLoaderStats } = await importFreshModule<
      typeof import("./plugin-module-loader-cache.js")
    >(import.meta.url, "./plugin-module-loader-cache.js?scope=native-require-fastpath");

    const cache = new Map();
    const loader = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      loaderFilename: "file:///repo/src/plugins/public-surface-loader.ts",
      createLoader: asPluginModuleLoaderFactory(createJiti),
    });

    const result = loader("/repo/dist/extensions/demo/api.js") as { loadedFrom: string };
    expect(result.loadedFrom).toBe("/repo/dist/extensions/demo/api.js");
    // Jiti should not be constructed or invoked for .js targets that
    // `tryNativeRequireJavaScriptModule` resolves.
    expect(createJiti).not.toHaveBeenCalled();
    expect(fromSourceTransformer).not.toHaveBeenCalled();
    // allowWindows must be passed so the native fast path works on Windows too.
    expectNativeOptions(nativeStub, "/repo/dist/extensions/demo/api.js");
    expectStats(getPluginModuleLoaderStats(), {
      calls: 1,
      nativeHits: 1,
      nativeMisses: 0,
      sourceTransformFallbacks: 0,
      sourceTransformForced: 0,
    });
  });

  it("does not source-transform fallback after native loading reaches a missing dependency", async () => {
    const fromSourceTransformer = vi.fn();
    const createJiti = vi.fn(() => fromSourceTransformer);
    vi.doMock("jiti", () => ({ createJiti }));
    const missingDependency = Object.assign(new Error("Cannot find module 'missing-dep'"), {
      code: "MODULE_NOT_FOUND",
    });
    const nativeStub = vi.fn(() => {
      throw missingDependency;
    });
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: nativeStub,
    }));
    const { getCachedPluginModuleLoader, getPluginModuleLoaderStats } = await importFreshModule<
      typeof import("./plugin-module-loader-cache.js")
    >(import.meta.url, "./plugin-module-loader-cache.js?scope=native-missing-dependency");

    const cache = new Map();
    const loader = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      loaderFilename: "file:///repo/src/plugins/public-surface-loader.ts",
      createLoader: asPluginModuleLoaderFactory(createJiti),
    });

    expect(() => loader("/repo/dist/extensions/demo/api.js")).toThrow("missing-dep");
    expect(createJiti).not.toHaveBeenCalled();
    expect(fromSourceTransformer).not.toHaveBeenCalled();
    expectNativeOptions(nativeStub, "/repo/dist/extensions/demo/api.js");
    expectStats(getPluginModuleLoaderStats(), {
      calls: 1,
      nativeHits: 0,
      nativeMisses: 0,
      sourceTransformFallbacks: 0,
      sourceTransformForced: 0,
    });
  });

  it("falls back to source transform when the native-require helper declines", async () => {
    const fromSourceTransformer = vi.fn(() => ({ fromSourceTransform: true }));
    const createJiti = vi.fn(() => fromSourceTransformer);
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: () => ({ ok: false }),
    }));
    const { getCachedPluginModuleLoader, getPluginModuleLoaderStats } = await importFreshModule<
      typeof import("./plugin-module-loader-cache.js")
    >(import.meta.url, "./plugin-module-loader-cache.js?scope=native-require-fallback");

    const cache = new Map();
    const loader = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      loaderFilename: "file:///repo/src/plugins/public-surface-loader.ts",
      createLoader: asPluginModuleLoaderFactory(createJiti),
    });

    const result = loader("/repo/dist/extensions/demo/api.js") as { fromSourceTransform: boolean };
    expect(result.fromSourceTransform).toBe(true);
    expectJitiOptions(createJiti, 0, "file:///repo/src/plugins/public-surface-loader.ts", {
      tryNative: true,
    });
    expect(fromSourceTransformer).toHaveBeenCalledWith("/repo/dist/extensions/demo/api.js");
    const stats = expectStats(getPluginModuleLoaderStats(), {
      calls: 1,
      nativeHits: 0,
      nativeMisses: 1,
      sourceTransformFallbacks: 1,
      sourceTransformForced: 0,
    });
    expect(stats.topSourceTransformTargets).toEqual([
      { target: "/repo/dist/extensions/demo/api.js", count: 1 },
    ]);
  });

  it("normalizes Windows absolute paths before creating and calling the source transformer", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const fromSourceTransformer = vi.fn(() => ({ fromSourceTransform: true }));
    const createJiti = vi.fn(() => fromSourceTransformer);
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
      createLoader: asPluginModuleLoaderFactory(createJiti),
    });

    loader("C:\\Users\\alice\\openclaw\\dist\\extensions\\feishu\\api.js");

    expectJitiOptions(
      createJiti,
      0,
      "file:///C:/Users/alice/openclaw/dist/extensions/feishu/api.js",
      { tryNative: true },
    );
    expect(fromSourceTransformer).toHaveBeenCalledWith(
      "file:///C:/Users/alice/openclaw/dist/extensions/feishu/api.js",
    );
  });

  it("skips the native-require fast path when tryNative is explicitly false", async () => {
    const fromSourceTransformer = vi.fn(() => ({ fromSourceTransform: true }));
    const createJiti = vi.fn(() => fromSourceTransformer);
    const nativeStub = vi.fn(() => ({ ok: true, moduleExport: { fromNative: true } }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: nativeStub,
    }));
    const { getCachedPluginModuleLoader, getPluginModuleLoaderStats } = await importFreshModule<
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
      createLoader: asPluginModuleLoaderFactory(createJiti),
    });

    const result = loader("/repo/dist/extensions/demo/api.js") as { fromSourceTransform: boolean };
    expect(result.fromSourceTransform).toBe(true);
    // With tryNative: false the wrapper must route every target through the source transformer
    // so its alias rewrites still apply; native require must not be consulted.
    expect(nativeStub).not.toHaveBeenCalled();
    expect(fromSourceTransformer).toHaveBeenCalledWith("/repo/dist/extensions/demo/api.js");
    const stats = expectStats(getPluginModuleLoaderStats(), {
      calls: 1,
      nativeHits: 0,
      nativeMisses: 0,
      sourceTransformFallbacks: 0,
      sourceTransformForced: 1,
    });
    expect(stats.topSourceTransformTargets).toEqual([
      { target: "/repo/dist/extensions/demo/api.js", count: 1 },
    ]);
  });

  it("normalizes Windows absolute paths when native loading is disabled", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const fromSourceTransformer = vi.fn(() => ({ fromSourceTransform: true }));
    const createJiti = vi.fn(() => fromSourceTransformer);
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
      createLoader: asPluginModuleLoaderFactory(createJiti),
    });

    loader("C:\\Users\\alice\\openclaw\\extensions\\feishu\\api.ts");

    expect(nativeStub).not.toHaveBeenCalled();
    expectJitiOptions(createJiti, 0, "file:///C:/Users/alice/openclaw/extensions/feishu/api.ts", {
      tryNative: false,
    });
    expect(fromSourceTransformer).toHaveBeenCalledWith(
      "file:///C:/Users/alice/openclaw/extensions/feishu/api.ts",
    );
  });

  it("forwards extra loader arguments through to the source-transform fallback", async () => {
    const fromSourceTransformer = vi.fn(() => ({ fromSourceTransform: true }));
    const createJiti = vi.fn(() => fromSourceTransformer);
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
      createLoader: asPluginModuleLoaderFactory(createJiti),
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
