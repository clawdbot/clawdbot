import { createJiti } from "jiti";
import { toSafeImportPath } from "../shared/import-specifier.js";
import { tryNativeRequireJavaScriptModule } from "./native-module-require.js";
import {
  buildPluginLoaderJitiOptions,
  createPluginLoaderJitiCacheKey,
  resolvePluginLoaderJitiConfig,
  type PluginSdkResolutionPreference,
} from "./sdk-alias.js";

export type PluginJitiLoader = ReturnType<typeof createJiti>;
export type PluginJitiLoaderFactory = typeof createJiti;
export type PluginJitiLoaderCache = Map<string, PluginJitiLoader>;

export function getCachedPluginJitiLoader(params: {
  cache: PluginJitiLoaderCache;
  modulePath: string;
  importerUrl: string;
  argvEntry?: string;
  preferBuiltDist?: boolean;
  jitiFilename?: string;
  createLoader?: PluginJitiLoaderFactory;
  aliasMap?: Record<string, string>;
  tryNative?: boolean;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  cacheScopeKey?: string;
}): PluginJitiLoader {
  const jitiFilename = toSafeImportPath(params.jitiFilename ?? params.modulePath);
  if (params.cacheScopeKey) {
    const scopedCacheKey = `${jitiFilename}::${params.cacheScopeKey}`;
    const cached = params.cache.get(scopedCacheKey);
    if (cached) {
      return cached;
    }
  }
  const hasAliasOverride = Boolean(params.aliasMap);
  const hasTryNativeOverride = typeof params.tryNative === "boolean";
  const defaultConfig =
    hasAliasOverride || hasTryNativeOverride
      ? resolvePluginLoaderJitiConfig({
          modulePath: params.modulePath,
          argv1: params.argvEntry ?? process.argv[1],
          moduleUrl: params.importerUrl,
          ...(params.preferBuiltDist ? { preferBuiltDist: true } : {}),
          ...(params.pluginSdkResolution
            ? { pluginSdkResolution: params.pluginSdkResolution }
            : {}),
        })
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
    : resolvePluginLoaderJitiConfig({
        modulePath: params.modulePath,
        argv1: params.argvEntry ?? process.argv[1],
        moduleUrl: params.importerUrl,
        ...(params.preferBuiltDist ? { preferBuiltDist: true } : {}),
        ...(params.pluginSdkResolution ? { pluginSdkResolution: params.pluginSdkResolution } : {}),
      });
  const { tryNative, aliasMap } = resolved;
  const cacheKey =
    resolved.cacheKey ??
    createPluginLoaderJitiCacheKey({
      tryNative,
      aliasMap,
    });
  const scopedCacheKey = `${jitiFilename}::${params.cacheScopeKey ?? cacheKey}`;
  const cached = params.cache.get(scopedCacheKey);
  if (cached) {
    return cached;
  }
  const jitiLoader = (params.createLoader ?? createJiti)(jitiFilename, {
    ...buildPluginLoaderJitiOptions(aliasMap),
    tryNative,
  });
  const loadWithJiti = new Proxy(jitiLoader, {
    apply(target, thisArg, argArray) {
      const [first, ...rest] = argArray as [unknown, ...unknown[]];
      if (typeof first === "string") {
        return Reflect.apply(target, thisArg, [toSafeImportPath(first), ...rest] as never) as never;
      }
      return Reflect.apply(target, thisArg, argArray as never) as never;
    },
  });
  // When the caller has explicitly opted out of native loading (for example
  // `bundled-capability-runtime` in Vitest+dist mode, which depends on
  // jiti's alias rewriting to surface a narrow SDK slice), route every
  // target through jiti so those alias rewrites still apply.
  if (!tryNative) {
    params.cache.set(scopedCacheKey, loadWithJiti);
    return loadWithJiti;
  }
  // Otherwise prefer native require() for already-compiled JS artifacts
  // (the bundled plugin public surfaces shipped in dist/). jiti's transform
  // pipeline provides no value for output that is already plain JS and adds
  // several seconds of per-load overhead on slower hosts. jiti still runs
  // for TS / TSX sources and for the small set of require(esm) /
  // async-module fallbacks `tryNativeRequireJavaScriptModule` declines to
  // handle.
  const loader = ((target: string, ...rest: unknown[]) => {
    const native = tryNativeRequireJavaScriptModule(target, { allowWindows: true });
    if (native.ok) {
      return native.moduleExport;
    }
    return (loadWithJiti as (t: string, ...a: unknown[]) => unknown)(target, ...rest);
  }) as PluginJitiLoader;
  params.cache.set(scopedCacheKey, loader);
  return loader;
}
