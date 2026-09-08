/** Caches plugin module loaders and native-load stats for runtime/source module imports. */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { createJiti } from "jiti";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { sameFileIdentity } from "../infra/fs-safe-advanced.js";
import { toSafeImportPath } from "../shared/import-specifier.js";
import {
  clearPluginModuleRequireCache,
  tryNativeRequireJavaScriptModule,
  tryNativeRequireModule,
} from "./native-module-require.js";
import {
  bindPluginCacheRoot,
  getPluginCache,
  getPluginCacheRoot,
  getPluginCacheSource,
  withPluginCache,
} from "./plugin-cache.js";
import { installOpenClawInternalCorePackageNativeResolver } from "./plugin-sdk-native-resolver.js";
import {
  buildPluginLoaderJitiOptions,
  createPluginLoaderModuleCacheKey,
  preparePluginLoaderAliases,
  isPluginSdkAliasSpecifier,
  resolvePluginLoaderTryNative,
  type PluginSdkResolutionPreference,
} from "./sdk-alias.js";

/** Jiti-based module loader used for plugin source/runtime imports. */
type PluginModuleLoader = (target: string) => unknown;
export type PluginModuleLoaderFactory = typeof createJiti;
type ResolvePluginModuleLoaderCacheEntryParams = {
  modulePath: string;
  rootDir?: string;
  importerUrl: string;
  argvEntry?: string;
  preferBuiltDist?: boolean;
  loaderFilename?: string;
  aliasMap?: Record<string, string>;
  tryNative?: boolean;
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  cacheScopeKey?: string;
  sharedCacheScopeKey?: string;
  transformOpenClawDependencies?: boolean;
};
type PluginModuleLoaderCacheEntry = {
  loaderFilename: string;
  getAliasMap: () => Record<string, string>;
  resolveAlias: (specifier: string) => string | undefined;
  tryNative: boolean;
  transformOpenClawDependencies: boolean;
  cacheKey: string;
  scopedCacheKey: string;
};
type PluginModuleLoaderStatsSnapshot = {
  calls: number;
  nativeHits: number;
  nativeMisses: number;
  sourceTransformForced: number;
  sourceTransformFallbacks: number;
  topSourceTransformTargets: Array<{ target: string; count: number }>;
};

const MAX_TRACKED_SOURCE_TRANSFORM_TARGETS = 24;
const requireForJiti = createRequire(import.meta.url);
let createJitiLoaderFactory: PluginModuleLoaderFactory | undefined;
const pluginModuleLoaderStats = {
  calls: 0,
  nativeHits: 0,
  nativeMisses: 0,
  sourceTransformForced: 0,
  sourceTransformFallbacks: 0,
  sourceTransformTargets: new Map<string, number>(),
};

function recordSourceTransformTarget(target: string): void {
  const current = pluginModuleLoaderStats.sourceTransformTargets.get(target) ?? 0;
  pluginModuleLoaderStats.sourceTransformTargets.set(target, current + 1);
  if (pluginModuleLoaderStats.sourceTransformTargets.size <= MAX_TRACKED_SOURCE_TRANSFORM_TARGETS) {
    return;
  }
  let leastUsedTarget: string | undefined;
  let leastUsedCount = Number.POSITIVE_INFINITY;
  for (const [candidate, count] of pluginModuleLoaderStats.sourceTransformTargets) {
    if (count < leastUsedCount) {
      leastUsedTarget = candidate;
      leastUsedCount = count;
    }
  }
  if (leastUsedTarget) {
    pluginModuleLoaderStats.sourceTransformTargets.delete(leastUsedTarget);
  }
}

/** Returns process-local plugin module loader stats for diagnostics and tests. */
export function getPluginModuleLoaderStats(): PluginModuleLoaderStatsSnapshot {
  return {
    calls: pluginModuleLoaderStats.calls,
    nativeHits: pluginModuleLoaderStats.nativeHits,
    nativeMisses: pluginModuleLoaderStats.nativeMisses,
    sourceTransformForced: pluginModuleLoaderStats.sourceTransformForced,
    sourceTransformFallbacks: pluginModuleLoaderStats.sourceTransformFallbacks,
    topSourceTransformTargets: [...pluginModuleLoaderStats.sourceTransformTargets]
      .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([target, count]) => ({ target, count })),
  };
}

function loadCreateJitiLoaderFactory(): PluginModuleLoaderFactory {
  if (createJitiLoaderFactory) {
    return createJitiLoaderFactory;
  }
  const loaded = requireForJiti("jiti") as { createJiti?: PluginModuleLoaderFactory };
  if (typeof loaded.createJiti !== "function") {
    throw new Error("jiti module did not export createJiti");
  }
  createJitiLoaderFactory = loaded.createJiti;
  return createJitiLoaderFactory;
}

function retainModuleLifecycle(cache: ReturnType<typeof getPluginCache>): void {
  cache.disposeModules ??= () => {
    for (const [modulePath, source] of cache.sources) {
      const rootDir = source.boundaryRoot;
      if (!rootDir) {
        continue;
      }
      const extensionsDir =
        path.basename(rootDir) === "extensions" ? rootDir : path.dirname(rootDir);
      const distDir = path.dirname(extensionsDir);
      const dependencyRoot =
        path.basename(extensionsDir) === "extensions" && path.basename(distDir) === "dist"
          ? distDir
          : rootDir;
      clearPluginModuleRequireCache(modulePath, { dependencyRoot });
    }
  };
}

/** Direct native imports share the generation's dependency cleanup with transformed modules. */
export function recordPluginModuleRoot(modulePath: string, rootDir: string): void {
  const cache = getPluginCache();
  getPluginCacheSource(modulePath, cache).boundaryRoot = rootDir;
  retainModuleLifecycle(cache);
}

function toSourceTransformImportPath(specifier: string): string {
  if (process.platform === "win32" && path.isAbsolute(specifier)) {
    return pathToFileURL(specifier).href;
  }
  return toSafeImportPath(specifier);
}

function resolvePluginModuleLoaderCacheEntry(
  params: ResolvePluginModuleLoaderCacheEntryParams,
): PluginModuleLoaderCacheEntry {
  const loaderFilename = toSafeImportPath(params.loaderFilename ?? params.modulePath);
  const tryNative = params.tryNative ?? resolvePluginLoaderTryNative(params.modulePath, params);
  // Explicit maps are content-keyed and captured before a retained loader can escape.
  const explicit = params.aliasMap ? { ...params.aliasMap } : undefined;
  const aliases = explicit
    ? {
        cacheKey: createPluginLoaderModuleCacheKey({ tryNative, aliasMap: explicit }),
        getAliasMap: () => explicit,
        resolveAlias: (specifier: string) => explicit[specifier],
      }
    : preparePluginLoaderAliases({
        modulePath: params.modulePath,
        argv1: params.argvEntry ?? process.argv[1],
        moduleUrl: params.importerUrl,
        devSourceRoot: params.devSourceRoot,
        pluginSdkResolution: params.pluginSdkResolution,
      });
  const moduleConfigCacheKey = `${tryNative ? "native" : "transform"}\0${aliases.cacheKey}`;
  const transformOpenClawDependencies = params.transformOpenClawDependencies ?? tryNative;
  const cacheKey = `${moduleConfigCacheKey}\0transform-openclaw=${transformOpenClawDependencies ? "1" : "0"}`;
  const scopedCacheKey = `${loaderFilename}::${
    params.sharedCacheScopeKey ??
    (params.cacheScopeKey ? `${params.cacheScopeKey}::${cacheKey}` : cacheKey)
  }`;
  return {
    loaderFilename,
    getAliasMap: aliases.getAliasMap,
    resolveAlias: aliases.resolveAlias,
    tryNative,
    transformOpenClawDependencies,
    cacheKey,
    scopedCacheKey,
  };
}

function createLazySourceTransformLoader(params: {
  loaderFilename: string;
  getAliasMap: () => Record<string, string>;
  resolveAlias: (specifier: string) => string | undefined;
  transformOpenClawDependencies: boolean;
  createLoader?: PluginModuleLoaderFactory;
}): () => PluginModuleLoader {
  let loadWithSourceTransform: PluginModuleLoader | undefined;
  return () => {
    if (loadWithSourceTransform) {
      return loadWithSourceTransform;
    }
    const jitiOptions = buildPluginLoaderJitiOptions(params.getAliasMap(), {
      modulePath: params.loaderFilename,
    });
    const jitiLoader = (params.createLoader ?? loadCreateJitiLoaderFactory())(
      params.loaderFilename,
      {
        ...jitiOptions,
        // Source SDK aliases resolve outside node_modules, so Jiti's nativeModules
        // matcher misses them. Keep host state native while plugin source remains
        // transformable and reloadable within its cache generation.
        virtualModules: params.transformOpenClawDependencies
          ? undefined
          : new Proxy<Record<string, unknown>>(
              {},
              {
                has(_target, key) {
                  return (
                    typeof key === "string" &&
                    isPluginSdkAliasSpecifier(key) &&
                    Boolean(params.resolveAlias(key))
                  );
                },
                get(_target, key) {
                  const target = typeof key === "string" ? params.resolveAlias(key) : undefined;
                  if (!target) {
                    return undefined;
                  }
                  const native = tryNativeRequireModule(target, {
                    allowWindows: true,
                    fallbackOnMissingDependency: true,
                  });
                  return native.ok ? native.moduleExport : jitiLoader(target);
                },
              },
            ),
        nativeModules: params.transformOpenClawDependencies
          ? jitiOptions.nativeModules.filter((moduleName) => moduleName !== "openclaw")
          : jitiOptions.nativeModules,
        tryNative: false,
      },
    );
    loadWithSourceTransform = (target) => jitiLoader(toSourceTransformImportPath(target));
    return loadWithSourceTransform;
  };
}

function createPluginModuleLoader(params: {
  loaderFilename: string;
  getAliasMap: () => Record<string, string>;
  resolveAlias: (specifier: string) => string | undefined;
  tryNative: boolean;
  transformOpenClawDependencies: boolean;
  createLoader?: PluginModuleLoaderFactory;
  cache: ReturnType<typeof getPluginCache>;
  cacheKey: string;
  rootDir?: string;
}): PluginModuleLoader {
  // A declined native require can leave an ESM dependency in flight. The
  // fallback must transform both the entry and OpenClaw SDK dependencies.
  const getLoadWithSourceTransform = createLazySourceTransformLoader({
    ...params,
  });
  const loadCachedTarget = (target: string, load: () => unknown): unknown => {
    const source = getPluginCacheSource(target, params.cache);
    const cached = source.variants.get(params.cacheKey)?.exports;
    if (cached) {
      return cached.value;
    }
    source.boundaryRoot =
      params.rootDir ??
      source.boundaryRoot ??
      path.dirname(target.startsWith("file:") ? fileURLToPath(target) : target);
    // Lazy transforms and nested imports must read the creating generation,
    // even when a retained loader is invoked from a newer operation scope.
    const loaded = withPluginCache(params.cache, load);
    source.variants.set(params.cacheKey, { exports: { value: loaded } });
    return loaded;
  };
  // When the caller has explicitly opted out of native loading, route every
  // target through jiti so caller-provided alias rewrites still apply.
  if (!params.tryNative) {
    return (target) =>
      loadCachedTarget(target, () => {
        pluginModuleLoaderStats.calls += 1;
        pluginModuleLoaderStats.sourceTransformForced += 1;
        recordSourceTransformTarget(target);
        return getLoadWithSourceTransform()(target);
      });
  }
  // Otherwise prefer native require() for already-compiled JS artifacts
  // (the bundled plugin public surfaces shipped in dist/). jiti's transform
  // pipeline provides no value for output that is already plain JS and adds
  // several seconds of per-load overhead on slower hosts. jiti still runs
  // for TS / TSX sources and for the small set of require(esm) /
  // async-module fallbacks `tryNativeRequireJavaScriptModule` declines to
  // handle.
  return (target) =>
    loadCachedTarget(target, () => {
      pluginModuleLoaderStats.calls += 1;
      const native = tryNativeRequireJavaScriptModule(target, {
        allowWindows: true,
        aliasMap: params.resolveAlias,
        fallbackOnMissingDependency: true,
      });
      if (native.ok) {
        pluginModuleLoaderStats.nativeHits += 1;
        return native.moduleExport;
      }
      pluginModuleLoaderStats.nativeMisses += 1;
      pluginModuleLoaderStats.sourceTransformFallbacks += 1;
      recordSourceTransformTarget(target);
      return getLoadWithSourceTransform()(target);
    });
}

export function getCachedPluginModuleLoader(
  params: ResolvePluginModuleLoaderCacheEntryParams & {
    createLoader?: PluginModuleLoaderFactory;
  },
): PluginModuleLoader {
  const cacheEntry = resolvePluginModuleLoaderCacheEntry(params);
  const cache = getPluginCache();
  const cached = cache.moduleLoaders.get(cacheEntry.scopedCacheKey);
  if (cached) {
    return cached;
  }
  // Exact-key hits already own the native aliases installed with their loader;
  // reinstallation would rescan the host package on every cached request.
  installOpenClawInternalCorePackageNativeResolver({ moduleUrl: params.importerUrl });
  retainModuleLifecycle(cache);
  const loader = createPluginModuleLoader({
    cache,
    cacheKey: cacheEntry.scopedCacheKey,
    rootDir: params.rootDir,
    loaderFilename: cacheEntry.loaderFilename,
    getAliasMap: cacheEntry.getAliasMap,
    resolveAlias: cacheEntry.resolveAlias,
    tryNative: cacheEntry.tryNative,
    transformOpenClawDependencies: cacheEntry.transformOpenClawDependencies,
    ...(params.createLoader ? { createLoader: params.createLoader } : {}),
  });
  cache.moduleLoaders.set(cacheEntry.scopedCacheKey, loader);
  return loader;
}

type PluginModuleBoundaryParams = {
  modulePath: string;
  boundaryRoot: string;
  boundaryLabel: string;
  rejectHardlinks: boolean;
  surfaceLabel: string;
};

/** Validates an entry once per generation without changing its module export shape. */
export function preparePluginModule(params: PluginModuleBoundaryParams) {
  const cache = getPluginCache();
  let source = getPluginCacheSource(params.modulePath, cache);
  const boundaryKey = `${getPluginCacheRoot(params.boundaryRoot).rootDir}\0${params.rejectHardlinks}`;
  if (source.validatedBoundaries.has(boundaryKey)) {
    return { source, modulePath: source.modulePath ?? params.modulePath };
  }
  const opened = openRootFileSync({
    absolutePath: params.modulePath,
    rootPath: params.boundaryRoot,
    boundaryLabel: params.boundaryLabel,
    rejectHardlinks: params.rejectHardlinks,
  });
  if (!opened.ok) {
    throw new Error(`Unable to open ${params.surfaceLabel}`, { cause: opened.error });
  }
  fs.closeSync(opened.fd);
  if (!sameFileIdentity(opened.stat, fs.statSync(opened.path))) {
    throw new Error(`${params.surfaceLabel} changed after validation`);
  }
  const root = bindPluginCacheRoot(params.boundaryRoot, opened.rootRealPath);
  // Facades reuse the first checked root classification. Explicit stricter
  // callers still validate their own policy through validatedBoundaries above.
  root.publicSurfaceBoundary ??= {
    boundaryLabel: params.boundaryLabel,
    rejectHardlinks: params.rejectHardlinks,
  };
  cache.sourceAliases.set(path.resolve(params.modulePath), opened.path);
  source = getPluginCacheSource(opened.path, cache);
  source.modulePath = opened.path;
  source.validatedBoundaries.add(`${opened.rootRealPath}\0${params.rejectHardlinks}`);
  retainModuleLifecycle(cache);
  return { source, modulePath: opened.path };
}

/** Public artifacts and SDK facades share one validated module, including circular imports. */
export function loadPluginPublicSurfaceModuleSync(
  params: PluginModuleBoundaryParams & {
    loadModule: (modulePath: string) => unknown;
  },
): object {
  const { source, modulePath } = preparePluginModule(params);
  const cached = source.publicSurface?.exports;
  if (cached) {
    return cached;
  }
  const sentinel: Record<string, unknown> = {};
  source.publicSurface = { exports: sentinel };
  source.boundaryRoot = params.boundaryRoot;
  try {
    Object.assign(sentinel, params.loadModule(modulePath));
    return sentinel;
  } catch (error) {
    delete source.publicSurface;
    source.validatedBoundaries.clear();
    throw error;
  }
}

export async function loadPluginPublicSurfaceModule(
  params: PluginModuleBoundaryParams & {
    loadModule: (modulePath: string) => Promise<object>;
  },
): Promise<object> {
  const { source, modulePath } = preparePluginModule(params);
  const cached = source.publicSurface;
  if (cached?.exports) {
    return cached.exports;
  }
  if (cached?.pending) {
    return cached.pending;
  }
  source.boundaryRoot = params.boundaryRoot;
  const pending = params.loadModule(modulePath).then(
    (loaded) => {
      source.publicSurface = { exports: loaded };
      return loaded;
    },
    (error: unknown) => {
      delete source.publicSurface;
      source.validatedBoundaries.clear();
      throw error;
    },
  );
  source.publicSurface = { pending };
  return pending;
}

export function getCachedPluginSourceModuleLoader(
  params: Omit<Parameters<typeof getCachedPluginModuleLoader>[0], "tryNative">,
): PluginModuleLoader {
  return getCachedPluginModuleLoader({
    ...params,
    tryNative: false,
  });
}
