import { createJiti } from "jiti";
import {
  buildPluginLoaderJitiOptions,
  createPluginLoaderJitiCacheKey,
  resolvePluginLoaderJitiConfig,
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
  cacheScopeKey?: string;
}): PluginJitiLoader {
  const jitiFilename = params.jitiFilename ?? params.modulePath;
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
        })
      : null;
  const resolved = defaultConfig
    ? {
        tryNative: params.tryNative ?? defaultConfig.tryNative,
        aliasMap: params.aliasMap ?? defaultConfig.aliasMap,
        cacheKey:
          !hasAliasOverride &&
          (!hasTryNativeOverride || params.tryNative === defaultConfig.tryNative)
            ? defaultConfig.cacheKey
            : undefined,
      }
    : resolvePluginLoaderJitiConfig({
        modulePath: params.modulePath,
        argv1: params.argvEntry ?? process.argv[1],
        moduleUrl: params.importerUrl,
        ...(params.preferBuiltDist ? { preferBuiltDist: true } : {}),
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
  const loader = (params.createLoader ?? createJiti)(jitiFilename, {
    ...buildPluginLoaderJitiOptions(aliasMap),
    tryNative,
  });
  params.cache.set(scopedCacheKey, loader);
  return loader;
}
