// Facade loader helpers resolve plugin public API modules from source, dist, or installed roots.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { shouldRejectHardlinkedPluginFiles } from "../plugins/hardlink-policy.js";
import {
  getPluginCacheRoot,
  getPluginCacheSource,
  resetPluginCache,
} from "../plugins/plugin-cache.js";
import {
  getCachedPluginModuleLoader,
  loadPluginPublicSurfaceModule,
  loadPluginPublicSurfaceModuleSync,
  type PluginModuleLoaderFactory,
} from "../plugins/plugin-module-loader-cache.js";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";
import {
  createFacadeResolutionKey,
  resolveBundledFacadeModuleLocation,
} from "./facade-resolution-shared.js";

/** Error thrown when a bundled plugin public surface artifact cannot be resolved. */
export class MissingPublicSurfaceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MissingPublicSurfaceError";
  }
}

const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);

const loadedFacadePluginIds = new Set<string>();
let facadeLoaderSourceTransformFactory: PluginModuleLoaderFactory | undefined;
function getOpenClawPackageRoot() {
  return (
    resolveLoaderPackageRoot({
      modulePath: fileURLToPath(import.meta.url),
      moduleUrl: import.meta.url,
    }) ?? fileURLToPath(new URL("../..", import.meta.url))
  );
}

function resolveFacadeModuleLocation(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): { modulePath: string; boundaryRoot: string } | null {
  const bundledPluginsDir = resolveBundledPluginsDir(params.env ?? process.env);
  const key = `facade:${createFacadeResolutionKey({ ...params, bundledPluginsDir })}`;
  const artifacts = getPluginCacheRoot(getOpenClawPackageRoot()).artifacts;
  const cached = artifacts.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const location = resolveBundledFacadeModuleLocation({
    ...params,
    currentModulePath: CURRENT_MODULE_PATH,
    packageRoot: getOpenClawPackageRoot(),
    bundledPluginsDir,
  });
  artifacts.set(key, location);
  return location;
}

function getModuleLoader(modulePath: string) {
  return getCachedPluginModuleLoader({
    modulePath,
    importerUrl: import.meta.url,
    preferBuiltDist: true,
    loaderFilename: import.meta.url,
    ...(facadeLoaderSourceTransformFactory
      ? { createLoader: facadeLoaderSourceTransformFactory }
      : {}),
  });
}

function createLazyFacadeValueLoader<T>(load: () => T): () => T {
  let loaded = false;
  let value: T;
  return () => {
    if (!loaded) {
      value = load();
      loaded = true;
    }
    return value;
  };
}

function createLazyFacadeProxyValue<T extends object>(params: {
  load: () => T;
  target: object;
}): T {
  const resolve = createLazyFacadeValueLoader(params.load);
  return new Proxy(params.target, {
    defineProperty(_target, property, descriptor) {
      return Reflect.defineProperty(resolve(), property, descriptor);
    },
    deleteProperty(_target, property) {
      return Reflect.deleteProperty(resolve(), property);
    },
    get(_target, property, receiver) {
      return Reflect.get(resolve(), property, receiver);
    },
    getOwnPropertyDescriptor(_target, property) {
      return Reflect.getOwnPropertyDescriptor(resolve(), property);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(resolve());
    },
    has(_target, property) {
      return Reflect.has(resolve(), property);
    },
    isExtensible() {
      return Reflect.isExtensible(resolve());
    },
    ownKeys() {
      return Reflect.ownKeys(resolve());
    },
    preventExtensions() {
      return Reflect.preventExtensions(resolve());
    },
    set(_target, property, value, receiver) {
      return Reflect.set(resolve(), property, value, receiver);
    },
    setPrototypeOf(_target, prototype) {
      return Reflect.setPrototypeOf(resolve(), prototype);
    },
  }) as T;
}

/** Create an object proxy that loads the underlying facade only on first property access. */
export function createLazyFacadeObjectValue<T extends object>(load: () => T): T {
  return createLazyFacadeProxyValue({ load, target: {} });
}

/** Create an array proxy that loads the underlying facade only on first array access. */
export function createLazyFacadeArrayValue<T extends readonly unknown[]>(load: () => T): T {
  return createLazyFacadeProxyValue({ load, target: [] });
}

/** Resolved public-surface module path plus the filesystem root it must stay within. */
export type FacadeModuleLocation = {
  modulePath: string;
  boundaryRoot: string;
};

function trackFacadeModule(modulePath: string, pluginId: string | (() => string)): void {
  const source = getPluginCacheSource(modulePath);
  if (source.facadeTracked) {
    return;
  }
  source.facadeTracked = true;
  try {
    loadedFacadePluginIds.add(typeof pluginId === "function" ? pluginId() : pluginId);
  } catch (error) {
    delete source.facadeTracked;
    throw error;
  }
}

function isPathAtOrInside(target: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

// Registry-resolved locations can point at installed plugin roots, which must
// reject hardlinked artifacts (see hardlink-policy.ts); core-shipped roots keep
// hardlinks allowed for bundled dist/Nix layouts.
function resolveFacadeBoundaryOpenParams(boundaryRoot: string): {
  boundaryLabel: string;
  rejectHardlinks: boolean;
} {
  const checked = getPluginCacheRoot(boundaryRoot).publicSurfaceBoundary;
  if (checked) {
    return checked;
  }
  if (isPathAtOrInside(boundaryRoot, getOpenClawPackageRoot())) {
    return { boundaryLabel: "OpenClaw package root", rejectHardlinks: false };
  }
  const bundledDir = resolveBundledPluginsDir();
  if (bundledDir && isPathAtOrInside(boundaryRoot, bundledDir)) {
    return { boundaryLabel: "bundled plugin directory", rejectHardlinks: false };
  }
  return {
    boundaryLabel: "plugin root",
    rejectHardlinks: shouldRejectHardlinkedPluginFiles({ origin: "global", rootDir: boundaryRoot }),
  };
}

/** Load and cache a facade module after verifying it is inside its declared boundary root. */
export function loadFacadeModuleAtLocationSync<T extends object>(params: {
  location: FacadeModuleLocation;
  trackedPluginId: string | (() => string);
  loadModule?: (modulePath: string) => T;
}): T {
  const location = params.location;
  const loaded = loadPluginPublicSurfaceModuleSync({
    ...location,
    ...resolveFacadeBoundaryOpenParams(location.boundaryRoot),
    surfaceLabel: `bundled plugin public surface ${location.modulePath}`,
    loadModule: params.loadModule ?? ((modulePath) => getModuleLoader(modulePath)(modulePath)),
  });
  trackFacadeModule(location.modulePath, params.trackedPluginId);
  return loaded as T;
}

/** Resolve and synchronously load a bundled plugin public surface by plugin dir and artifact name. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic facade loaders use caller-supplied module surface types.
export function loadBundledPluginPublicSurfaceModuleSyncCore<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
  trackedPluginId?: string | (() => string);
  env?: NodeJS.ProcessEnv;
}): T {
  const location = resolveFacadeModuleLocation(params);
  if (!location) {
    throw new MissingPublicSurfaceError(
      `Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
    );
  }
  return loadFacadeModuleAtLocationSync({
    location,
    trackedPluginId: params.trackedPluginId ?? params.dirName,
  });
}

/** Resolve and asynchronously import a bundled plugin public surface with sync-loader fallback. */
export async function loadBundledPluginPublicSurfaceModule<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
  trackedPluginId?: string | (() => string);
}): Promise<T> {
  const location = resolveFacadeModuleLocation(params);
  if (!location) {
    throw new MissingPublicSurfaceError(
      `Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
    );
  }
  const loaded = await loadPluginPublicSurfaceModule({
    ...location,
    ...resolveFacadeBoundaryOpenParams(location.boundaryRoot),
    surfaceLabel: `bundled plugin public surface ${location.modulePath}`,
    loadModule: async (modulePath) => {
      try {
        // Native ESM imports cannot be evicted; bundled core-dist artifacts change only on restart.
        return (await import(pathToFileURL(modulePath).href)) as T;
      } catch {
        return loadFacadeModuleAtLocationSync<T>({
          location,
          trackedPluginId: params.trackedPluginId ?? params.dirName,
        });
      }
    },
  });
  trackFacadeModule(location.modulePath, params.trackedPluginId ?? params.dirName);
  return loaded as T;
}

/** List plugin ids whose public facades have been loaded in this process. */
export function listImportedBundledPluginFacadeIds(): string[] {
  return [...loadedFacadePluginIds].toSorted((left, right) => left.localeCompare(right));
}

/** Reset facade module caches and test loader overrides. */
export function resetFacadeLoaderStateForTest(): void {
  resetPluginCache();
  loadedFacadePluginIds.clear();
  facadeLoaderSourceTransformFactory = undefined;
}

/** Override source transform loader creation for facade-loader tests. */
export function setFacadeLoaderSourceTransformFactoryForTest(
  factory: PluginModuleLoaderFactory | undefined,
): void {
  facadeLoaderSourceTransformFactory = factory;
}
