import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import {
  getCachedPluginJitiLoader,
  type PluginJitiLoaderCache,
} from "../plugins/jiti-loader-cache.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  PUBLIC_SURFACE_SOURCE_EXTENSIONS,
  normalizeBundledPluginArtifactSubpath,
  resolveBundledPluginSourcePublicSurfacePath,
  resolveBundledPluginPublicSurfacePath,
} from "../plugins/public-surface-runtime.js";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";
import {
  loadBundledPluginPublicSurfaceModuleSync as loadBundledPluginPublicSurfaceModuleSyncLight,
  loadFacadeModuleAtLocationSync as loadFacadeModuleAtLocationSyncShared,
  resetFacadeLoaderStateForTest,
  type FacadeModuleLocation,
} from "./facade-loader.js";
export {
  createLazyFacadeArrayValue,
  createLazyFacadeObjectValue,
  listImportedBundledPluginFacadeIds,
} from "./facade-loader.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const OPENCLAW_SOURCE_EXTENSIONS_ROOT = path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions");
const cachedFacadeModuleLocationsByKey = new Map<
  string,
  {
    modulePath: string;
    boundaryRoot: string;
  } | null
>();

function createFacadeResolutionKey(params: { dirName: string; artifactBasename: string }): string {
  const bundledPluginsDir = resolveBundledPluginsDir();
  return `${params.dirName}::${params.artifactBasename}::${bundledPluginsDir ? path.resolve(bundledPluginsDir) : "<default>"}`;
}

function resolveRegistryPluginModuleLocationFromRegistry(params: {
  registry: readonly Pick<PluginManifestRecord, "id" | "rootDir" | "channels">[];
  dirName: string;
  artifactBasename: string;
}): { modulePath: string; boundaryRoot: string } | null {
  type RegistryRecord = (typeof params.registry)[number];
  const tiers: Array<(plugin: RegistryRecord) => boolean> = [
    (plugin) => plugin.id === params.dirName,
    (plugin) => path.basename(plugin.rootDir) === params.dirName,
    (plugin) => plugin.channels.includes(params.dirName),
  ];
  const artifactBasename = normalizeBundledPluginArtifactSubpath(params.artifactBasename);
  const sourceBaseName = artifactBasename.replace(/\.js$/u, "");
  for (const matchFn of tiers) {
    for (const record of params.registry.filter(matchFn)) {
      const rootDir = path.resolve(record.rootDir);
      const builtCandidate = path.join(rootDir, artifactBasename);
      if (fs.existsSync(builtCandidate)) {
        return { modulePath: builtCandidate, boundaryRoot: rootDir };
      }
      for (const ext of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
        const sourceCandidate = path.join(rootDir, `${sourceBaseName}${ext}`);
        if (fs.existsSync(sourceCandidate)) {
          return { modulePath: sourceCandidate, boundaryRoot: rootDir };
        }
      }
    }
  }
  return null;
}

function resolveRegistryPluginModuleLocation(params: {
  dirName: string;
  artifactBasename: string;
}): { modulePath: string; boundaryRoot: string } | null {
  return loadFacadeActivationCheckRuntime().resolveRegistryPluginModuleLocation({
    ...params,
    resolutionKey: createFacadeResolutionKey(params),
  });
}

function resolveFacadeModuleLocationUncached(params: {
  dirName: string;
  artifactBasename: string;
}): { modulePath: string; boundaryRoot: string } | null {
  const bundledPluginsDir = resolveBundledPluginsDir();
  const preferSource = !CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`);
  if (preferSource) {
    const modulePath =
      resolveBundledPluginSourcePublicSurfacePath({
        ...params,
        sourceRoot: bundledPluginsDir ?? path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions"),
      }) ??
      resolveBundledPluginPublicSurfacePath({
        rootDir: OPENCLAW_PACKAGE_ROOT,
        ...(bundledPluginsDir ? { bundledPluginsDir } : {}),
        dirName: params.dirName,
        artifactBasename: params.artifactBasename,
      });
    if (modulePath) {
      return {
        modulePath,
        boundaryRoot:
          bundledPluginsDir && modulePath.startsWith(path.resolve(bundledPluginsDir) + path.sep)
            ? path.resolve(bundledPluginsDir)
            : OPENCLAW_PACKAGE_ROOT,
      };
    }
    return resolveRegistryPluginModuleLocation(params);
  }
  const modulePath = resolveBundledPluginPublicSurfacePath({
    rootDir: OPENCLAW_PACKAGE_ROOT,
    ...(bundledPluginsDir ? { bundledPluginsDir } : {}),
    dirName: params.dirName,
    artifactBasename: params.artifactBasename,
  });
  if (modulePath) {
    return {
      modulePath,
      boundaryRoot:
        bundledPluginsDir && modulePath.startsWith(path.resolve(bundledPluginsDir) + path.sep)
          ? path.resolve(bundledPluginsDir)
          : OPENCLAW_PACKAGE_ROOT,
    };
  }
  return resolveRegistryPluginModuleLocation(params);
}

function resolveFacadeModuleLocation(params: {
  dirName: string;
  artifactBasename: string;
}): { modulePath: string; boundaryRoot: string } | null {
  const key = createFacadeResolutionKey(params);
  if (cachedFacadeModuleLocationsByKey.has(key)) {
    return cachedFacadeModuleLocationsByKey.get(key) ?? null;
  }
  const resolved = resolveFacadeModuleLocationUncached(params);
  cachedFacadeModuleLocationsByKey.set(key, resolved);
  return resolved;
}

type BundledPluginPublicSurfaceParams = {
  dirName: string;
  artifactBasename: string;
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
  });
}

export function canLoadActivatedBundledPluginPublicSurface(params: {
  dirName: string;
  artifactBasename: string;
}): boolean {
  return loadFacadeActivationCheckRuntime().resolveBundledPluginPublicSurfaceAccess(
    buildFacadeActivationCheckParams(params),
  ).allowed;
}

export function loadActivatedBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
}): T {
  loadFacadeActivationCheckRuntime().resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(
    buildFacadeActivationCheckParams(params),
  );
  return loadBundledPluginPublicSurfaceModuleSync<T>(params);
}

export function tryLoadActivatedBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
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
  cachedFacadeModuleLocationsByKey.clear();
}

export const __testing = {
  loadFacadeModuleAtLocationSync,
  resolveRegistryPluginModuleLocationFromRegistry,
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
