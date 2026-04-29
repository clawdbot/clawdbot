import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import {
  getCachedPluginJitiLoader,
  type PluginJitiLoaderCache,
} from "../plugins/jiti-loader-cache.js";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";
import {
  loadBundledPluginPublicSurfaceModuleSync as loadBundledPluginPublicSurfaceModuleSyncLight,
  loadFacadeModuleAtLocationSync as loadFacadeModuleAtLocationSyncShared,
  resetFacadeLoaderStateForTest,
  type FacadeModuleLocation,
} from "./facade-loader.js";
import {
  createFacadeResolutionKey as createFacadeResolutionKeyShared,
  resolveBundledFacadeModuleLocation,
  resolveRegistryPluginModuleLocationFromRecords,
} from "./facade-resolution-shared.js";
export {
  createLazyFacadeArrayValue,
  createLazyFacadeObjectValue,
  listImportedBundledPluginFacadeIds,
} from "./facade-loader.js";

export function createLazyFacadeValue<TFacade extends object, K extends keyof TFacade>(
  loadFacadeModule: () => TFacade,
  key: K,
): TFacade[K] {
  return ((...args: unknown[]) => {
    const value = loadFacadeModule()[key];
    if (typeof value !== "function") {
      return value;
    }
    return (value as (...innerArgs: unknown[]) => unknown)(...args);
  }) as TFacade[K];
}

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const OPENCLAW_SOURCE_EXTENSIONS_ROOT = path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions");

function createFacadeResolutionKey(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const bundledPluginsDir = resolveBundledPluginsDir(params.env ?? process.env);
  return createFacadeResolutionKeyShared({
    ...params,
    bundledPluginsDir,
    ...(params.env ? { env: params.env } : {}),
  });
}

function resolveRegistryPluginModuleLocation(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): { modulePath: string; boundaryRoot: string } | null {
  return loadFacadeActivationCheckRuntime().resolveRegistryPluginModuleLocation({
    ...params,
    resolutionKey: createFacadeResolutionKey(params),
  });
}

function resolveFacadeModuleLocationUncached(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): { modulePath: string; boundaryRoot: string } | null {
  const bundledPluginsDir = resolveBundledPluginsDir(params.env ?? process.env);
  const bundledLocation = resolveBundledFacadeModuleLocation({
    ...params,
    currentModulePath: CURRENT_MODULE_PATH,
    packageRoot: OPENCLAW_PACKAGE_ROOT,
    bundledPluginsDir,
  });
  if (bundledLocation) {
    return bundledLocation;
  }
  return resolveRegistryPluginModuleLocation(params);
}

function resolveFacadeModuleLocation(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): { modulePath: string; boundaryRoot: string } | null {
  return resolveFacadeModuleLocationUncached(params);
}

type BundledPluginPublicSurfaceParams = {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
};

type FacadeActivationCheckRuntimeModule = typeof import("./facade-activation-check.runtime.js");

const nodeRequire = createRequire(import.meta.url);
const FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES = [
  "./facade-activation-check.runtime.js",
  "./facade-activation-check.runtime.ts",
] as const;

let facadeActivationCheckRuntimeModule: FacadeActivationCheckRuntimeModule | undefined;
const facadeActivationCheckRuntimeJitiLoaders: PluginJitiLoaderCache = new Map();

function getFacadeActivationCheckRuntimeJiti(modulePath: string) {
  return getCachedPluginJitiLoader({
    cache: facadeActivationCheckRuntimeJitiLoaders,
    modulePath,
    importerUrl: import.meta.url,
    jitiFilename: import.meta.url,
    aliasMap: {},
    tryNative: false,
  });
}

function loadFacadeActivationCheckRuntimeFromCandidates(
  loadCandidate: (
    candidate: (typeof FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES)[number],
  ) => unknown,
): FacadeActivationCheckRuntimeModule | undefined {
  for (const candidate of FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES) {
    try {
      return loadCandidate(candidate) as FacadeActivationCheckRuntimeModule;
    } catch {
      // Try source/runtime candidates in order.
    }
  }
  return undefined;
}

function loadFacadeActivationCheckRuntime(): FacadeActivationCheckRuntimeModule {
  if (facadeActivationCheckRuntimeModule) {
    return facadeActivationCheckRuntimeModule;
  }
  facadeActivationCheckRuntimeModule = loadFacadeActivationCheckRuntimeFromCandidates((candidate) =>
    nodeRequire(candidate),
  );
  if (facadeActivationCheckRuntimeModule) {
    return facadeActivationCheckRuntimeModule;
  }
  facadeActivationCheckRuntimeModule = loadFacadeActivationCheckRuntimeFromCandidates((candidate) =>
    getFacadeActivationCheckRuntimeJiti(candidate)(candidate),
  );
  if (facadeActivationCheckRuntimeModule) {
    return facadeActivationCheckRuntimeModule;
  }
  throw new Error("Unable to load facade activation check runtime");
}

function loadFacadeModuleAtLocationSync<T extends object>(params: {
  location: FacadeModuleLocation;
  trackedPluginId: string | (() => string);
  runtimeDeps?: {
    pluginId: string;
    env?: NodeJS.ProcessEnv;
  };
  loadModule?: (modulePath: string) => T;
}): T {
  return loadFacadeModuleAtLocationSyncShared(params);
}

function buildFacadeActivationCheckParams(
  params: BundledPluginPublicSurfaceParams,
  location: FacadeModuleLocation | null = resolveFacadeModuleLocation(params),
) {
  return {
    ...params,
    location,
    sourceExtensionsRoot: OPENCLAW_SOURCE_EXTENSIONS_ROOT,
    resolutionKey: createFacadeResolutionKey(params),
  };
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic facade loaders use caller-supplied module surface types.
export function loadBundledPluginPublicSurfaceModuleSync<T extends object>(
  params: BundledPluginPublicSurfaceParams,
): T {
  const location = resolveFacadeModuleLocation(params);
  const trackedPluginId = () =>
    loadFacadeActivationCheckRuntime().resolveTrackedFacadePluginId(
      buildFacadeActivationCheckParams(params, location),
    );
  if (!location) {
    return loadBundledPluginPublicSurfaceModuleSyncLight<T>({
      ...params,
      trackedPluginId,
    });
  }
  return loadFacadeModuleAtLocationSync<T>({
    location,
    trackedPluginId,
    runtimeDeps: {
      pluginId: params.dirName,
      ...(params.env ? { env: params.env } : {}),
    },
  });
}

export function canLoadActivatedBundledPluginPublicSurface(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return loadFacadeActivationCheckRuntime().resolveBundledPluginPublicSurfaceAccess(
    buildFacadeActivationCheckParams(params),
  ).allowed;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic facade loaders use caller-supplied module surface types.
export function loadActivatedBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): T {
  loadFacadeActivationCheckRuntime().resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(
    buildFacadeActivationCheckParams(params),
  );
  return loadBundledPluginPublicSurfaceModuleSync<T>(params);
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic facade loaders use caller-supplied module surface types.
export function tryLoadActivatedBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): T | null {
  const access = loadFacadeActivationCheckRuntime().resolveBundledPluginPublicSurfaceAccess(
    buildFacadeActivationCheckParams(params),
  );
  if (!access.allowed) {
    return null;
  }
  return loadBundledPluginPublicSurfaceModuleSync<T>(params);
}

export function resetFacadeRuntimeStateForTest(): void {
  resetFacadeLoaderStateForTest();
  facadeActivationCheckRuntimeModule?.resetFacadeActivationCheckRuntimeStateForTest();
  facadeActivationCheckRuntimeModule = undefined;
  facadeActivationCheckRuntimeJitiLoaders.clear();
}

export const __testing = {
  loadFacadeModuleAtLocationSync,
  resolveRegistryPluginModuleLocationFromRegistry: resolveRegistryPluginModuleLocationFromRecords,
  resolveFacadeModuleLocation,
  evaluateBundledPluginPublicSurfaceAccess: ((
    ...args: Parameters<
      FacadeActivationCheckRuntimeModule["evaluateBundledPluginPublicSurfaceAccess"]
    >
  ) =>
    loadFacadeActivationCheckRuntime().evaluateBundledPluginPublicSurfaceAccess(
      ...args,
    )) as FacadeActivationCheckRuntimeModule["evaluateBundledPluginPublicSurfaceAccess"],
  throwForBundledPluginPublicSurfaceAccess: ((
    ...args: Parameters<
      FacadeActivationCheckRuntimeModule["throwForBundledPluginPublicSurfaceAccess"]
    >
  ) =>
    loadFacadeActivationCheckRuntime().throwForBundledPluginPublicSurfaceAccess(
      ...args,
    )) as FacadeActivationCheckRuntimeModule["throwForBundledPluginPublicSurfaceAccess"],
  resolveActivatedBundledPluginPublicSurfaceAccessOrThrow: ((
    params: BundledPluginPublicSurfaceParams,
  ) =>
    loadFacadeActivationCheckRuntime().resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(
      buildFacadeActivationCheckParams(params),
    )) as (params: BundledPluginPublicSurfaceParams) => {
    allowed: boolean;
    pluginId?: string;
    reason?: string;
  },
  resolveBundledPluginPublicSurfaceAccess: ((params: BundledPluginPublicSurfaceParams) =>
    loadFacadeActivationCheckRuntime().resolveBundledPluginPublicSurfaceAccess(
      buildFacadeActivationCheckParams(params),
    )) as (params: BundledPluginPublicSurfaceParams) => {
    allowed: boolean;
    pluginId?: string;
    reason?: string;
  },
  resolveTrackedFacadePluginId: ((params: BundledPluginPublicSurfaceParams) =>
    loadFacadeActivationCheckRuntime().resolveTrackedFacadePluginId(
      buildFacadeActivationCheckParams(params),
    )) as (params: BundledPluginPublicSurfaceParams) => string,
};
