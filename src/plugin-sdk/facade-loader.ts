import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { prepareBuiltBundledPluginPublicSurfaceLocation } from "../plugins/bundled-public-surface-runtime-root.js";
import {
  getCachedPluginJitiLoader,
  type PluginJitiLoaderCache,
  type PluginJitiLoaderFactory,
} from "../plugins/jiti-loader-cache.js";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";
import { resolveBundledFacadeModuleLocation } from "./facade-resolution-shared.js";

const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);

const nodeRequire = createRequire(import.meta.url);
const jitiLoaders: PluginJitiLoaderCache = new Map();
const loadedFacadeModules = new Map<string, unknown>();
const loadedFacadePluginIds = new Set<string>();
let facadeLoaderJitiFactory: PluginJitiLoaderFactory | undefined;
let cachedOpenClawPackageRoot: string | undefined;

function getJitiFactory() {
  if (facadeLoaderJitiFactory) {
    return facadeLoaderJitiFactory;
  }
  const { createJiti } = nodeRequire("jiti") as typeof import("jiti");
  facadeLoaderJitiFactory = createJiti;
  return facadeLoaderJitiFactory;
}

function getOpenClawPackageRoot() {
  if (cachedOpenClawPackageRoot) {
    return cachedOpenClawPackageRoot;
  }
  cachedOpenClawPackageRoot =
    resolveLoaderPackageRoot({
      modulePath: fileURLToPath(import.meta.url),
      moduleUrl: import.meta.url,
    }) ?? fileURLToPath(new URL("../..", import.meta.url));
  return cachedOpenClawPackageRoot;
}

function resolveFacadeModuleLocation(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): { modulePath: string; boundaryRoot: string } | null {
  const bundledPluginsDir = resolveBundledPluginsDir(params.env ?? process.env);
  return resolveBundledFacadeModuleLocation({
    ...params,
    currentModulePath: CURRENT_MODULE_PATH,
    packageRoot: getOpenClawPackageRoot(),
    bundledPluginsDir,
  });
}

function getJiti(modulePath: string) {
  return getCachedPluginJitiLoader({
    cache: jitiLoaders,
    modulePath,
    importerUrl: import.meta.url,
    preferBuiltDist: true,
    jitiFilename: import.meta.url,
    createLoader: getJitiFactory(),
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

export function createLazyFacadeObjectValue<T extends object>(load: () => T): T {
  return createLazyFacadeProxyValue({ load, target: {} });
}

export function createLazyFacadeArrayValue<T extends readonly unknown[]>(load: () => T): T {
  return createLazyFacadeProxyValue({ load, target: [] });
}

export type FacadeModuleLocation = {
  modulePath: string;
  boundaryRoot: string;
};

function prepareFacadeLocationForBundledRuntimeDeps(params: {
  location: FacadeModuleLocation;
  runtimeDeps?: {
    pluginId: string;
    env?: NodeJS.ProcessEnv;
  };
}): FacadeModuleLocation {
  if (!params.runtimeDeps) {
    return params.location;
  }
  return prepareBuiltBundledPluginPublicSurfaceLocation({
    location: params.location,
    pluginId: params.runtimeDeps.pluginId,
    ...(params.runtimeDeps.env ? { env: params.runtimeDeps.env } : {}),
  });
}

export function loadFacadeModuleAtLocationSync<T extends object>(params: {
  location: FacadeModuleLocation;
  trackedPluginId: string | (() => string);
  runtimeDeps?: {
    pluginId: string;
    env?: NodeJS.ProcessEnv;
  };
  loadModule?: (modulePath: string) => T;
}): T {
  const location = prepareFacadeLocationForBundledRuntimeDeps({
    location: params.location,
    ...(params.runtimeDeps ? { runtimeDeps: params.runtimeDeps } : {}),
  });
  const cached = loadedFacadeModules.get(location.modulePath);
  if (cached) {
    return cached as T;
  }

  const opened = openBoundaryFileSync({
    absolutePath: location.modulePath,
    rootPath: location.boundaryRoot,
    boundaryLabel:
      location.boundaryRoot === getOpenClawPackageRoot()
        ? "OpenClaw package root"
        : (() => {
            const bundledDir = resolveBundledPluginsDir();
            return bundledDir && path.resolve(location.boundaryRoot) === path.resolve(bundledDir)
              ? "bundled plugin directory"
              : "plugin root";
          })(),
    rejectHardlinks: false,
  });
  if (!opened.ok) {
    throw new Error(`Unable to open bundled plugin public surface ${location.modulePath}`, {
      cause: opened.error,
    });
  }
  fs.closeSync(opened.fd);

  const sentinel = {} as T;
  loadedFacadeModules.set(location.modulePath, sentinel);

  let loaded: T;
  try {
    loaded =
      params.loadModule?.(location.modulePath) ??
      (getJiti(location.modulePath)(location.modulePath) as T);
    Object.assign(sentinel, loaded);
    loadedFacadePluginIds.add(
      typeof params.trackedPluginId === "function"
        ? params.trackedPluginId()
        : params.trackedPluginId,
    );
  } catch (err) {
    loadedFacadeModules.delete(location.modulePath);
    throw err;
  }

  return sentinel;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic facade loaders use caller-supplied module surface types.
export function loadBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
  trackedPluginId?: string | (() => string);
  env?: NodeJS.ProcessEnv;
}): T {
  const location = resolveFacadeModuleLocation(params);
  if (!location) {
    throw new Error(
      `Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
    );
  }
  return loadFacadeModuleAtLocationSync({
    location,
    trackedPluginId: params.trackedPluginId ?? params.dirName,
    runtimeDeps: {
      pluginId: params.dirName,
      ...(params.env ? { env: params.env } : {}),
    },
  });
}

export async function loadBundledPluginPublicSurfaceModule<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
  trackedPluginId?: string | (() => string);
  env?: NodeJS.ProcessEnv;
}): Promise<T> {
  const location = resolveFacadeModuleLocation(params);
  if (!location) {
    throw new Error(
      `Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
    );
  }
  const preparedLocation = prepareFacadeLocationForBundledRuntimeDeps({
    location,
    runtimeDeps: {
      pluginId: params.dirName,
      ...(params.env ? { env: params.env } : {}),
    },
  });
  const cached = loadedFacadeModules.get(preparedLocation.modulePath);
  if (cached) {
    return cached as T;
  }

  const opened = openBoundaryFileSync({
    absolutePath: preparedLocation.modulePath,
    rootPath: preparedLocation.boundaryRoot,
    boundaryLabel:
      preparedLocation.boundaryRoot === getOpenClawPackageRoot()
        ? "OpenClaw package root"
        : "plugin root",
    rejectHardlinks: false,
  });
  if (!opened.ok) {
    throw new Error(`Unable to open bundled plugin public surface ${preparedLocation.modulePath}`, {
      cause: opened.error,
    });
  }
  fs.closeSync(opened.fd);

  try {
    const loaded = (await import(pathToFileURL(preparedLocation.modulePath).href)) as T;
    loadedFacadeModules.set(preparedLocation.modulePath, loaded);
    loadedFacadePluginIds.add(
      typeof params.trackedPluginId === "function"
        ? params.trackedPluginId()
        : (params.trackedPluginId ?? params.dirName),
    );
    return loaded;
  } catch {
    return loadFacadeModuleAtLocationSync({
      location: preparedLocation,
      trackedPluginId: params.trackedPluginId ?? params.dirName,
    });
  }
}

export function listImportedBundledPluginFacadeIds(): string[] {
  return [...loadedFacadePluginIds].toSorted((left, right) => left.localeCompare(right));
}

export function resetFacadeLoaderStateForTest(): void {
  loadedFacadeModules.clear();
  loadedFacadePluginIds.clear();
  jitiLoaders.clear();
  facadeLoaderJitiFactory = undefined;
  cachedOpenClawPackageRoot = undefined;
}

export function setFacadeLoaderJitiFactoryForTest(
  factory: PluginJitiLoaderFactory | undefined,
): void {
  facadeLoaderJitiFactory = factory;
}
