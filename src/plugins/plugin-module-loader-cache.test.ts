/** Tests plugin module loader cache keys and lifecycle reset behavior. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createRequireRecord, importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import {
  createPluginCache,
  getPluginCache,
  resetPluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import type { PluginModuleLoaderFactory } from "./plugin-module-loader-cache.js";

async function importPluginModuleLoader(scope: string) {
  const actual = await importFreshModule<typeof import("./plugin-module-loader-cache.js")>(
    import.meta.url,
    scope,
  );
  type LoaderParams = Parameters<typeof actual.getCachedPluginModuleLoader>[0];
  type Cache = ReturnType<typeof createPluginCache>["moduleLoaders"];
  const owners = new WeakMap<Cache, ReturnType<typeof createPluginCache>>();
  const inCache = (params: LoaderParams & { cache: Cache }, sourceOnly = false) => {
    const { cache, ...options } = params;
    let owner = owners.get(cache);
    if (!owner) {
      owner = createPluginCache();
      owner.moduleLoaders = cache;
      owners.set(cache, owner);
    }
    return withPluginCache(owner, () =>
      sourceOnly
        ? actual.getCachedPluginSourceModuleLoader(options)
        : actual.getCachedPluginModuleLoader(options),
    );
  };
  return {
    ...actual,
    getCachedPluginModuleLoader: (params: LoaderParams & { cache: Cache }) => inCache(params),
    getCachedPluginSourceModuleLoader: (
      params: Omit<LoaderParams, "tryNative"> & { cache: Cache },
    ) => inCache(params, true),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("jiti");
  resetPluginCache();
});

async function loadCachedPluginModuleLoader(scope: string) {
  const createJiti = vi.fn((filename: string, options?: Record<string, unknown>) =>
    Object.assign(vi.fn(), {
      filename,
      options,
    }),
  );

  const pluginModuleLoaderCache = await importPluginModuleLoader(
    `./plugin-module-loader-cache.js?scope=${scope}`,
  );
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

const requireRecord = createRequireRecord("object", "expected-label");

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
  expect(options.fallbackOnNativeError).toBeUndefined();
}

function expectStats(value: unknown, fields: Record<string, unknown>) {
  const stats = requireRecord(value, "loader stats");
  for (const [key, expected] of Object.entries(fields)) {
    expect(stats[key]).toEqual(expected);
  }
  return stats;
}

describe("getCachedPluginModuleLoader", () => {
  it("shares native SDK state while keeping plugin source reloadable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-sdk-graph-"));
    try {
      const ownerPath = path.join(root, "loader.mjs");
      await build({
        stdin: {
          contents:
            'export * from "./src/plugins/plugin-module-loader-cache.ts"; export { resetPluginCache } from "./src/plugins/plugin-cache.ts";',
          resolveDir: process.cwd(),
        },
        bundle: true,
        packages: "external",
        platform: "node",
        format: "esm",
        outfile: ownerPath,
        logLevel: "silent",
      });
      fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
      const result = spawnNodeEvalSync(
        `
          import assert from "node:assert/strict";
          import fs from "node:fs";
          import path from "node:path";
          import { pathToFileURL } from "node:url";
          import { getCachedPluginModuleLoader, resetPluginCache } from ${JSON.stringify(pathToFileURL(ownerPath).href)};
          const root = ${JSON.stringify(root)};
          for (const transformOpenClawDependencies of [false, true]) {
            const sdk = path.join(root, "sdk-" + transformOpenClawDependencies + ".mts");
            fs.writeFileSync(sdk, "export const state: object = {};\\n");
            const native = await import(pathToFileURL(sdk).href);
            const rootDir = path.join(root, "plugin-" + transformOpenClawDependencies);
            fs.mkdirSync(rootDir);
            const modulePath = path.join(rootDir, "entry.ts");
            const dependency = path.join(rootDir, "dependency.ts");
            fs.writeFileSync(modulePath, 'export { state } from "openclaw/plugin-sdk/fixture"; export { value } from "./dependency.ts";\\n');
            fs.writeFileSync(dependency, "export const value: number = 1;\\n");
            const load = () => getCachedPluginModuleLoader({
              modulePath, rootDir, importerUrl: import.meta.url, tryNative: false,
              transformOpenClawDependencies,
              aliasMap: { "openclaw/plugin-sdk/fixture": sdk },
            })(modulePath);
            const first = load();
            assert.equal(first.state === native.state, !transformOpenClawDependencies, "SDK loading mode must preserve its graph contract");
            fs.writeFileSync(dependency, "export const value: number = 2;\\n");
            assert.equal(load(), first);
            assert.equal(first.value, 1);
            resetPluginCache();
            const second = load();
            assert.equal(second.value, 2, "plugin dependencies reload with their generation");
            assert.equal(second.state, first.state, "host SDK state survives plugin reload");
            resetPluginCache();
          }
          const loadSdkFixture = (name, source) => {
            const sdk = path.join(root, name + ".mts");
            const modulePath = path.join(root, name + "-entry.ts");
            fs.mkdirSync(path.dirname(sdk), { recursive: true });
            fs.writeFileSync(sdk, source);
            fs.writeFileSync(modulePath, 'export * from "openclaw/plugin-sdk/fixture";\\n');
            const loader = getCachedPluginModuleLoader({
              modulePath, rootDir: root, importerUrl: import.meta.url, tryNative: false,
              aliasMap: { "openclaw/plugin-sdk/fixture": sdk },
            });
            return () => loader(modulePath);
          };
          assert.equal(loadSdkFixture("enum", "enum State { Ready }\\nexport const ready = State.Ready;")().ready, 0);
          assert.equal(loadSdkFixture("source-host/node_modules/sdk/index", "export const ready: number = 1;")().ready, 1);
          const broken = loadSdkFixture("broken", 'globalThis.sdkEvaluations = (globalThis.sdkEvaluations ?? 0) + 1; throw new Error("SDK evaluation failed");');
          assert.throws(broken, /SDK evaluation failed/);
          assert.equal(globalThis.sdkEvaluations, 1, "terminal native failures must not evaluate SDK source twice");
        `,
        {
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: root,
            USERPROFILE: root,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            JITI_FS_CACHE: "0",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const withoutTypeStripping = spawnNodeEvalSync(
        `
          import assert from "node:assert/strict";
          import { getCachedPluginModuleLoader } from ${JSON.stringify(pathToFileURL(ownerPath).href)};
          const root = ${JSON.stringify(root)};
          const modulePath = root + "/enum-entry.ts";
          const load = getCachedPluginModuleLoader({
            modulePath, rootDir: root, importerUrl: import.meta.url, tryNative: false,
            aliasMap: { "openclaw/plugin-sdk/fixture": root + "/enum.mts" },
          });
          assert.equal(load(modulePath).ready, 0);
        `,
        {
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: root,
            USERPROFILE: root,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            NODE_OPTIONS: "--no-strip-types",
            JITI_FS_CACHE: "0",
          },
        },
      );
      expect(withoutTypeStripping.status, withoutTypeStripping.stderr).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps deferred module construction and evaluation in the creating cache generation", async () => {
    const { getCachedPluginModuleLoader } = await importFreshModule<
      typeof import("./plugin-module-loader-cache.js")
    >(import.meta.url, "./plugin-module-loader-cache.js?scope=retained-loader-generation");
    const owner = createPluginCache();
    const other = createPluginCache();
    const observedOwner: boolean[] = [];
    const createLoader = asPluginModuleLoaderFactory(() => {
      observedOwner.push(getPluginCache() === owner);
      return () => {
        observedOwner.push(getPluginCache() === owner);
        return { marker: "retained-generation" };
      };
    });
    const modulePath = "/repo/extensions/retained-generation/index.ts";
    const loader = withPluginCache(owner, () =>
      getCachedPluginModuleLoader({
        modulePath,
        importerUrl: import.meta.url,
        aliasMap: {},
        tryNative: false,
        createLoader,
      }),
    );

    const loaded = withPluginCache(other, () => {
      const value = loader(modulePath);
      expect(getPluginCache()).toBe(other);
      return value;
    });

    expect(loaded).toEqual({ marker: "retained-generation" });
    expect(observedOwner).toEqual([true, true]);
  });

  let filenameScopeCase: {
    cacheSize: number;
    firstAliasType: string;
    firstFilename: unknown;
    firstOptions: Record<string, unknown>;
    sameLoader: boolean;
    secondAliasType: string;
    secondFilename: unknown;
    secondOptions: Record<string, unknown>;
  };

  beforeAll(async () => {
    const { createJiti, getCachedPluginModuleLoader } = await loadCachedPluginModuleLoader(
      "filename-scope-precompute",
    );

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

    first("/repo/dist/extensions/demo/api.ts");
    second("/repo/dist/extensions/demo/api.ts");
    const calls = createJiti.mock.calls;
    const firstOptions = requireRecord(calls[0]?.[1], "first jiti options");
    const secondOptions = requireRecord(calls[1]?.[1], "second jiti options");
    filenameScopeCase = {
      cacheSize: cache.size,
      firstAliasType: typeof firstOptions.alias,
      firstFilename: calls[0]?.[0],
      firstOptions,
      sameLoader: second === first,
      secondAliasType: typeof secondOptions.alias,
      secondFilename: calls[1]?.[0],
      secondOptions,
    };
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

  it("installs native internal aliases only on exact loader cache misses", async () => {
    const nativeResolver = await import("./plugin-sdk-native-resolver.js");
    const installNativeResolver = vi.spyOn(
      nativeResolver,
      "installOpenClawInternalCorePackageNativeResolver",
    );
    const { getCachedPluginModuleLoader } = await loadCachedPluginModuleLoader(
      "native-resolver-cache-misses",
    );
    const cache = new Map();
    const params = {
      cache,
      modulePath: "/repo/extensions/demo/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      loaderFilename: "/repo/extensions/demo/index.ts",
      tryNative: false,
    } as const;

    const first = getCachedPluginModuleLoader(params);
    expect(installNativeResolver).toHaveBeenCalledTimes(1);
    expect(installNativeResolver).toHaveBeenCalledWith({ moduleUrl: params.importerUrl });

    expect(getCachedPluginModuleLoader(params)).toBe(first);
    expect(installNativeResolver).toHaveBeenCalledTimes(1);

    const differentlyScoped = getCachedPluginModuleLoader({
      ...params,
      cacheScopeKey: "different-loader-scope",
    });
    expect(differentlyScoped).not.toBe(first);
    expect(installNativeResolver).toHaveBeenCalledTimes(2);
    expect(installNativeResolver).toHaveBeenNthCalledWith(2, {
      moduleUrl: params.importerUrl,
    });
    expect(cache.size).toBe(2);
  });

  it("keeps loaders isolated between plugin cache generations", async () => {
    const { createJiti, getCachedPluginModuleLoader } =
      await loadCachedPluginModuleLoader("bounded-loader-cache");
    const cache = new Map();
    const first = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/extensions/demo-a/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      loaderFilename: "/repo/extensions/demo-a/index.ts",
    });
    getCachedPluginModuleLoader({
      cache: new Map(),
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
    expect(reloadedFirst).toBe(first);
    reloadedFirst("/repo/extensions/demo-a/index.ts");
    expect(createJiti).toHaveBeenCalledOnce();
  });

  it("keeps loader caches scoped by loader filename and dist preference", async () => {
    expect(filenameScopeCase.sameLoader).toBe(false);
    expect(filenameScopeCase.firstFilename).toBe(
      "file:///repo/src/plugins/public-surface-loader.ts",
    );
    expect(filenameScopeCase.firstOptions.tryNative).toBe(false);
    expect(filenameScopeCase.firstOptions.interopDefault).toBe(true);
    expect(filenameScopeCase.firstAliasType).toBe("object");
    expect(filenameScopeCase.secondFilename).toBe(
      "file:///repo/src/plugins/bundled-channel-config-metadata.ts",
    );
    expect(filenameScopeCase.secondOptions.tryNative).toBe(false);
    expect(filenameScopeCase.secondOptions.interopDefault).toBe(true);
    expect(filenameScopeCase.secondAliasType).toBe("object");
    expect(filenameScopeCase.cacheSize).toBe(2);
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
    expect(options.fsCache).toEqual(expect.any(String));
    expect(String(options.fsCache)).toContain(`${path.sep}openclaw${path.sep}jiti${path.sep}`);
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
    const { getCachedPluginModuleLoader, getPluginModuleLoaderStats } =
      await importPluginModuleLoader(
        "./plugin-module-loader-cache.js?scope=native-require-fastpath",
      );

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

  it("lets native require handle compiled plugin SDK aliases before source-transform fallback", async () => {
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
    const { getCachedPluginModuleLoader, getPluginModuleLoaderStats } =
      await importPluginModuleLoader(
        "./plugin-module-loader-cache.js?scope=native-require-plugin-sdk-alias",
      );

    const cache = new Map();
    const loader = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      loaderFilename: "file:///repo/src/plugins/public-surface-loader.ts",
      aliasMap: {
        "openclaw/plugin-sdk/core": "/repo/dist/plugin-sdk/core.js",
      },
      createLoader: asPluginModuleLoaderFactory(createJiti),
    });

    const result = loader("/repo/dist/extensions/demo/api.js") as { loadedFrom: string };
    expect(result.loadedFrom).toBe("/repo/dist/extensions/demo/api.js");
    expect(createJiti).not.toHaveBeenCalled();
    expect(fromSourceTransformer).not.toHaveBeenCalled();
    expectNativeOptions(nativeStub, "/repo/dist/extensions/demo/api.js");
    const options = callArg(nativeStub, 0, 1, "native options") as NonNullable<
      Parameters<typeof import("./native-module-require.js").tryNativeRequireJavaScriptModule>[1]
    >;
    const target =
      typeof options.aliasMap === "function"
        ? options.aliasMap("openclaw/plugin-sdk/core")
        : options.aliasMap?.["openclaw/plugin-sdk/core"];
    expect(target).toBe("/repo/dist/plugin-sdk/core.js");
    expectStats(getPluginModuleLoaderStats(), {
      calls: 1,
      nativeHits: 1,
      nativeMisses: 0,
      sourceTransformFallbacks: 0,
      sourceTransformForced: 0,
    });
  });

  it("reuses successful native module exports inside one loader", async () => {
    const fromSourceTransformer = vi.fn();
    const createJiti = vi.fn(() => fromSourceTransformer);
    const moduleExport = { marker: "native-cached" };
    const nativeStub = vi.fn(() => ({
      ok: true as const,
      moduleExport,
    }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: nativeStub,
    }));
    const { getCachedPluginModuleLoader, getPluginModuleLoaderStats } =
      await importPluginModuleLoader("./plugin-module-loader-cache.js?scope=native-export-cache");

    const cache = new Map();
    const loader = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      loaderFilename: "file:///repo/src/plugins/public-surface-loader.ts",
      createLoader: asPluginModuleLoaderFactory(createJiti),
    });

    expect(loader("/repo/dist/extensions/demo/api.js")).toBe(moduleExport);
    expect(loader("/repo/dist/extensions/demo/api.js")).toBe(moduleExport);
    expect(nativeStub).toHaveBeenCalledTimes(1);
    expect(createJiti).not.toHaveBeenCalled();
    expectStats(getPluginModuleLoaderStats(), {
      calls: 1,
      nativeHits: 1,
      nativeMisses: 0,
      sourceTransformFallbacks: 0,
      sourceTransformForced: 0,
    });
  });

  it("propagates native plugin evaluation errors without running the plugin twice", async () => {
    vi.doUnmock("./native-module-require.js");
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-native-evaluation-"));
    const modulePath = path.join(fixtureDir, "plugin.cjs");
    const markerName = `openclaw.pluginModuleLoaderCache.nativeEvaluation:${fixtureDir}`;
    const sideEffectMarker = Symbol.for(markerName);
    const expectedError = "plugin exploded during native evaluation";
    const fromSourceTransformer = vi.fn();
    const createJiti = vi.fn(() => fromSourceTransformer);

    try {
      fs.writeFileSync(
        modulePath,
        [
          `const marker = Symbol.for(${JSON.stringify(markerName)});`,
          "globalThis[marker] = (globalThis[marker] ?? 0) + 1;",
          `throw new Error(${JSON.stringify(expectedError)});`,
        ].join("\n"),
        "utf8",
      );
      const { getCachedPluginModuleLoader } = await importPluginModuleLoader(
        "./plugin-module-loader-cache.js?scope=native-evaluation-error",
      );
      const loader = getCachedPluginModuleLoader({
        cache: new Map(),
        modulePath,
        importerUrl: import.meta.url,
        loaderFilename: modulePath,
        tryNative: true,
        createLoader: asPluginModuleLoaderFactory(createJiti),
      });

      expect(() => loader(modulePath)).toThrow(expectedError);
      expect(Reflect.get(globalThis, sideEffectMarker)).toBe(1);
      expect(createJiti).not.toHaveBeenCalled();
      expect(fromSourceTransformer).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(globalThis, sideEffectMarker);
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
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
    const { getCachedPluginModuleLoader, getPluginModuleLoaderStats } =
      await importPluginModuleLoader(
        "./plugin-module-loader-cache.js?scope=native-missing-dependency",
      );

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
    const { getCachedPluginModuleLoader, getPluginModuleLoaderStats } =
      await importPluginModuleLoader(
        "./plugin-module-loader-cache.js?scope=native-require-fallback",
      );

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
    const options = expectJitiOptions(
      createJiti,
      0,
      "file:///repo/src/plugins/public-surface-loader.ts",
      {
        tryNative: false,
      },
    );
    expect(options.nativeModules).toEqual([]);
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

  it("can transform OpenClaw dependencies on a forced source fallback", async () => {
    const fromSourceTransformer = vi.fn(() => ({ fromSourceTransform: true }));
    const createJiti = vi.fn(() => fromSourceTransformer);
    const nativeStub = vi.fn(() => ({ ok: true, moduleExport: { fromNative: true } }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: nativeStub,
    }));
    const { getCachedPluginSourceModuleLoader } = await importPluginModuleLoader(
      "./plugin-module-loader-cache.js?scope=forced-source-native-fallback",
    );

    const loader = getCachedPluginSourceModuleLoader({
      cache: new Map(),
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugin-sdk/channel-entry-contract.ts",
      loaderFilename: "file:///repo/src/plugin-sdk/channel-entry-contract.ts",
      transformOpenClawDependencies: true,
      createLoader: asPluginModuleLoaderFactory(createJiti),
    });

    expect(loader("/repo/dist/extensions/demo/api.js")).toEqual({
      fromSourceTransform: true,
    });
    const options = requireRecord(callArg(createJiti, 0, 1, "jiti options"), "jiti options");
    expect(options.tryNative).toBe(false);
    expect(options.nativeModules).toEqual([]);
    expect(nativeStub).not.toHaveBeenCalled();
  });

  it("normalizes Windows absolute paths before creating and calling the source transformer", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const fromSourceTransformer = vi.fn(() => ({ fromSourceTransform: true }));
    const createJiti = vi.fn(() => fromSourceTransformer);
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: () => ({ ok: false }),
    }));
    const { getCachedPluginModuleLoader } = await importPluginModuleLoader(
      "./plugin-module-loader-cache.js?scope=windows-jiti-paths",
    );

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

    const options = expectJitiOptions(
      createJiti,
      0,
      "file:///C:/Users/alice/openclaw/dist/extensions/feishu/api.js",
      { tryNative: false },
    );
    expect(options.nativeModules).toEqual([]);
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
    const { getCachedPluginModuleLoader, getPluginModuleLoaderStats } =
      await importPluginModuleLoader(
        "./plugin-module-loader-cache.js?scope=native-require-opt-out",
      );

    const cache = new Map();
    const loader = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.js",
      importerUrl: "file:///repo/src/plugins/bundled-capability-runtime.ts",
      loaderFilename: "file:///repo/src/plugins/bundled-capability-runtime.ts",
      aliasMap: { "openclaw/plugin-sdk/core": "/repo/core.js" },
      tryNative: false,
      createLoader: asPluginModuleLoaderFactory(createJiti),
    });

    const result = loader("/repo/dist/extensions/demo/api.js") as { fromSourceTransform: boolean };
    expect(result.fromSourceTransform).toBe(true);
    const options = requireRecord(callArg(createJiti, 0, 1, "jiti options"), "jiti options");
    expect(options.tryNative).toBe(false);
    expect(options.nativeModules).toEqual(["openclaw"]);
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

  it("reuses successful source-transform module exports inside one loader", async () => {
    const moduleExport = { marker: "source-cached" };
    const fromSourceTransformer = vi.fn(() => moduleExport);
    const createJiti = vi.fn(() => fromSourceTransformer);
    const nativeStub = vi.fn(() => ({ ok: true, moduleExport: { fromNative: true } }));
    vi.doMock("./native-module-require.js", () => ({
      isJavaScriptModulePath: () => true,
      tryNativeRequireJavaScriptModule: nativeStub,
    }));
    const { getCachedPluginModuleLoader, getPluginModuleLoaderStats } =
      await importPluginModuleLoader("./plugin-module-loader-cache.js?scope=source-export-cache");

    const cache = new Map();
    const loader = getCachedPluginModuleLoader({
      cache,
      modulePath: "/repo/extensions/demo/api.ts",
      importerUrl: "file:///repo/src/plugins/bundled-capability-runtime.ts",
      loaderFilename: "file:///repo/src/plugins/bundled-capability-runtime.ts",
      tryNative: false,
      createLoader: asPluginModuleLoaderFactory(createJiti),
    });

    expect(loader("/repo/extensions/demo/api.ts")).toBe(moduleExport);
    expect(loader("/repo/extensions/demo/api.ts")).toBe(moduleExport);
    expect(nativeStub).not.toHaveBeenCalled();
    expect(fromSourceTransformer).toHaveBeenCalledTimes(1);
    const stats = expectStats(getPluginModuleLoaderStats(), {
      calls: 1,
      nativeHits: 0,
      nativeMisses: 0,
      sourceTransformFallbacks: 0,
      sourceTransformForced: 1,
    });
    expect(stats.topSourceTransformTargets).toEqual([
      { target: "/repo/extensions/demo/api.ts", count: 1 },
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
    const { getCachedPluginModuleLoader } = await importPluginModuleLoader(
      "./plugin-module-loader-cache.js?scope=windows-jiti-no-native",
    );

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
});

describe("plugin module cache generation cleanup", () => {
  it.each([
    { boundaryRoot: "/repo/dist/extensions/demo", dependencyRoot: "/repo/dist" },
    { boundaryRoot: "/repo/dist/extensions", dependencyRoot: "/repo/dist" },
    { boundaryRoot: "/repo/installed/demo", dependencyRoot: "/repo/installed/demo" },
  ])("evicts native dependencies under $dependencyRoot for $boundaryRoot", async (params) => {
    const clearPluginModuleRequireCache = vi.fn();
    vi.doMock("./native-module-require.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./native-module-require.js")>()),
      clearPluginModuleRequireCache,
    }));
    const { recordPluginModuleRoot } = await importPluginModuleLoader(
      "./plugin-module-loader-cache.js?scope=lifecycle-disposal",
    );
    const modulePath = "/repo/dist/extensions/demo/api.js";
    recordPluginModuleRoot(modulePath, params.boundaryRoot);
    const previous = getPluginCache();

    resetPluginCache();

    expect(clearPluginModuleRequireCache).toHaveBeenCalledWith(modulePath, {
      dependencyRoot: params.dependencyRoot,
    });
    expect(getPluginCache()).not.toBe(previous);
    expect(getPluginCache().sources.size).toBe(0);
  });
});
