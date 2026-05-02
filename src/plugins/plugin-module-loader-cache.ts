import { createJiti } from "jiti";
import { toSafeImportPath } from "../shared/import-specifier.js";
import { tryNativeRequireJavaScriptModule } from "./native-module-require.js";
import { PluginLruCache } from "./plugin-cache-primitives.js";
import {
  buildPluginLoaderJitiOptions,
  createPluginLoaderModuleCacheKey,
  resolvePluginLoaderModuleConfig,
  type PluginSdkResolutionPreference,
} from "./sdk-alias.js";

export type PluginModuleLoader = ReturnType<typeof createJiti>;
export type PluginModuleLoaderFactory = typeof createJiti;
export type PluginModuleLoaderCache = Pick<
  PluginLruCache<PluginModuleLoader>,
  "clear" | "get" | "set" | "size"
>;
export type ResolvePluginModuleLoaderCacheEntryParams = {
  modulePath: string;
  importerUrl: string;
  argvEntry?: string;
  preferBuiltDist?: boolean;
  loaderFilename?: string;
  aliasMap?: Record<string, string>;
  tryNative?: boolean;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  cacheScopeKey?: string;
  sharedCacheScopeKey?: string;
};
export type PluginModuleLoaderCacheEntry = {
  loaderFilename: string;
  aliasMap: Record<string, string>;
  tryNative: boolean;
  cacheKey: string;
  scopedCacheKey: string;
};

const DEFAULT_PLUGIN_MODULE_LOADER_CACHE_ENTRIES = 128;

export function createPluginModuleLoaderCache(
  maxEntries = DEFAULT_PLUGIN_MODULE_LOADER_CACHE_ENTRIES,
): PluginModuleLoaderCache {
  return new PluginLruCache<PluginModuleLoader>(maxEntries);
}

function resolveDefaultPluginModuleLoaderConfig(
  params: ResolvePluginModuleLoaderCacheEntryParams,
): ReturnType<typeof resolvePluginLoaderModuleConfig> {
  return resolvePluginLoaderModuleConfig({
    modulePath: params.modulePath,
    argv1: params.argvEntry ?? process.argv[1],
    moduleUrl: params.importerUrl,
    ...(params.preferBuiltDist ? { preferBuiltDist: true } : {}),
    ...(params.pluginSdkResolution ? { pluginSdkResolution: params.pluginSdkResolution } : {}),
  });
}

export function resolvePluginModuleLoaderCacheEntry(
  params: ResolvePluginModuleLoaderCacheEntryParams,
): PluginModuleLoaderCacheEntry {
  const loaderFilename = toSafeImportPath(params.loaderFilename ?? params.modulePath);
  const hasAliasOverride = Boolean(params.aliasMap);
  const hasTryNativeOverride = typeof params.tryNative === "boolean";
  const defaultConfig =
    hasAliasOverride || hasTryNativeOverride
      ? resolveDefaultPluginModuleLoaderConfig(params)
      : null;
  const canReuseDefaultCacheKey =
    defaultConfig !== null &&
    (!hasAliasOverride || params.aliasMap === defaultConfig.aliasMap) &&
    (!hasTryNativeOverride || params.tryNative === defaultConfig.tryNative);
  const resolved = defaultConfig
    ? {
        tryNative: params.tryNative ?? defaultConfig.tryNative,
        aliasMap: params.aliasMap ?? defaultConfig.aliasMap,
        cacheKey: canReuseDefaultCacheKey ? defaultConfig.cacheKey : undefined,
      }
    : resolveDefaultPluginModuleLoaderConfig(params);
  const { tryNative, aliasMap } = resolved;
  const cacheKey =
    resolved.cacheKey ??
    createPluginLoaderModuleCacheKey({
      tryNative,
      aliasMap,
    });
  const scopedCacheKey = `${loaderFilename}::${
    params.sharedCacheScopeKey ??
    (params.cacheScopeKey ? `${params.cacheScopeKey}::${cacheKey}` : cacheKey)
  }`;
  return {
    loaderFilename,
    aliasMap,
    tryNative,
    cacheKey,
    scopedCacheKey,
  };
}

function createLazySourceTransformLoader(params: {
  loaderFilename: string;
  aliasMap: Record<string, string>;
  tryNative: boolean;
  createLoader?: PluginModuleLoaderFactory;
}): () => PluginModuleLoader {
  let loadWithSourceTransform: PluginModuleLoader | undefined;
  return () => {
    if (loadWithSourceTransform) {
      return loadWithSourceTransform;
    }
    const jitiLoader = (params.createLoader ?? createJiti)(params.loaderFilename, {
      ...buildPluginLoaderJitiOptions(params.aliasMap),
      tryNative: params.tryNative,
    });
    loadWithSourceTransform = new Proxy(jitiLoader, {
      apply(target, thisArg, argArray) {
        const [first, ...rest] = argArray as [unknown, ...unknown[]];
        if (typeof first === "string") {
          return Reflect.apply(target, thisArg, [
            toSafeImportPath(first),
            ...rest,
          ] as never) as never;
        }
        return Reflect.apply(target, thisArg, argArray as never) as never;
      },
    });
    return loadWithSourceTransform;
  };
}

function createPluginModuleLoader(params: {
  loaderFilename: string;
  aliasMap: Record<string, string>;
  tryNative: boolean;
  createLoader?: PluginModuleLoaderFactory;
}): PluginModuleLoader {
  const getLoadWithSourceTransform = createLazySourceTransformLoader(params);
  // When the caller has explicitly opted out of native loading (for example
  // `bundled-capability-runtime` in Vitest+dist mode, which depends on
  // jiti's alias rewriting to surface a narrow SDK slice), route every
  // target through jiti so those alias rewrites still apply.
  if (!params.tryNative) {
    return ((target: string, ...rest: unknown[]) =>
      (getLoadWithSourceTransform() as (t: string, ...a: unknown[]) => unknown)(
        target,
        ...rest,
      )) as PluginModuleLoader;
  }
  // Otherwise prefer native require() for already-compiled JS artifacts
  // (the bundled plugin public surfaces shipped in dist/). jiti's transform
  // pipeline provides no value for output that is already plain JS and adds
  // several seconds of per-load overhead on slower hosts. jiti still runs
  // for TS / TSX sources and for the small set of require(esm) /
  // async-module fallbacks `tryNativeRequireJavaScriptModule` declines to
  // handle.
  return ((target: string, ...rest: unknown[]) => {
    const native = tryNativeRequireJavaScriptModule(target, { allowWindows: true });
    if (native.ok) {
      return native.moduleExport;
    }
    return (getLoadWithSourceTransform() as (t: string, ...a: unknown[]) => unknown)(
      target,
      ...rest,
    );
  }) as PluginModuleLoader;
}

export function getCachedPluginModuleLoader(
  params: ResolvePluginModuleLoaderCacheEntryParams & {
    cache: PluginModuleLoaderCache;
    createLoader?: PluginModuleLoaderFactory;
  },
): PluginModuleLoader {
  const cacheEntry = resolvePluginModuleLoaderCacheEntry(params);
  const cached = params.cache.get(cacheEntry.scopedCacheKey);
  if (cached) {
    return cached;
  }
  const loader = createPluginModuleLoader({
    loaderFilename: cacheEntry.loaderFilename,
    aliasMap: cacheEntry.aliasMap,
    tryNative: cacheEntry.tryNative,
    ...(params.createLoader ? { createLoader: params.createLoader } : {}),
  });
  params.cache.set(cacheEntry.scopedCacheKey, loader);
  return loader;
}

export function getCachedPluginSourceModuleLoader(
  params: Omit<Parameters<typeof getCachedPluginModuleLoader>[0], "tryNative">,
): PluginModuleLoader {
  return getCachedPluginModuleLoader({
    ...params,
    tryNative: false,
  });
}
