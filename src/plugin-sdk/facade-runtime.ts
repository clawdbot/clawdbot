// Facade runtime helpers load plugin API facades from installed plugin packages.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { areBundledPluginsDisabled, resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { getPluginCacheRoot, getPluginCacheSource } from "../plugins/plugin-cache.js";
import { getCachedPluginSourceModuleLoader } from "../plugins/plugin-module-loader-cache.js";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";
import {
  loadBundledPluginPublicSurfaceModuleSyncCore as loadBundledPluginPublicSurfaceModuleSyncLight,
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
  const env = params.env ?? process.env;
  if (!areBundledPluginsDisabled(env)) {
    const bundledPluginsDir = resolveBundledPluginsDir(env);
    const bundledLocation = resolveBundledFacadeModuleLocation({
      ...params,
      currentModulePath: CURRENT_MODULE_PATH,
      packageRoot: OPENCLAW_PACKAGE_ROOT,
      bundledPluginsDir,
    });
    if (bundledLocation) {
      return bundledLocation;
    }
  }
  return resolveRegistryPluginModuleLocation(params);
}

function resolveFacadeModuleLocation(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): { modulePath: string; boundaryRoot: string } | null {
  // Custom environments may select different installed-plugin profiles, so
  // their facade locations must not enter the process-wide gateway cache.
  if (params.env !== undefined && params.env !== process.env) {
    return resolveFacadeModuleLocationUncached(params);
  }
  const resolutionKey = `facade-registry:${createFacadeResolutionKey(params)}`;
  const artifacts = getPluginCacheRoot(OPENCLAW_PACKAGE_ROOT).artifacts;
  const cached = artifacts.get(resolutionKey);
  if (cached !== undefined) {
    return cached;
  }
  const location = resolveFacadeModuleLocationUncached(params);
  artifacts.set(resolutionKey, location);
  return location;
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

function getFacadeActivationCheckRuntimeModule(): FacadeActivationCheckRuntimeModule | undefined {
  const cached =
    getPluginCacheSource(CURRENT_MODULE_PATH).variants.get("activation-runtime")?.exports?.value;
  // SAFETY: This slot is written only by the typed host activation-runtime setter below.
  return cached as FacadeActivationCheckRuntimeModule | undefined;
}

function setFacadeActivationCheckRuntimeModule(module: FacadeActivationCheckRuntimeModule): void {
  getPluginCacheSource(CURRENT_MODULE_PATH).variants.set("activation-runtime", {
    exports: { value: module },
  });
}

function getFacadeActivationCheckRuntimeSourceLoader(modulePath: string) {
  return getCachedPluginSourceModuleLoader({
    modulePath,
    importerUrl: import.meta.url,
    loaderFilename: import.meta.url,
    aliasMap: {},
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
  let facadeActivationCheckRuntimeModule = getFacadeActivationCheckRuntimeModule();
  if (facadeActivationCheckRuntimeModule) {
    return facadeActivationCheckRuntimeModule;
  }
  facadeActivationCheckRuntimeModule = loadFacadeActivationCheckRuntimeFromCandidates((candidate) =>
    nodeRequire(candidate),
  );
  if (facadeActivationCheckRuntimeModule) {
    setFacadeActivationCheckRuntimeModule(facadeActivationCheckRuntimeModule);
    return facadeActivationCheckRuntimeModule;
  }
  facadeActivationCheckRuntimeModule = loadFacadeActivationCheckRuntimeFromCandidates((candidate) =>
    getFacadeActivationCheckRuntimeSourceLoader(candidate)(candidate),
  );
  if (facadeActivationCheckRuntimeModule) {
    setFacadeActivationCheckRuntimeModule(facadeActivationCheckRuntimeModule);
    return facadeActivationCheckRuntimeModule;
  }
  throw new Error("Unable to load facade activation check runtime");
}

// Async twin of loadFacadeActivationCheckRuntime for async call sites: dynamic
// import resolves the source graph under vitest where the sync createRequire/jiti
// candidates cannot, and warms the shared memo so subsequent sync loads reuse it.
async function loadFacadeActivationCheckRuntimeAsync(): Promise<FacadeActivationCheckRuntimeModule> {
  const module =
    getFacadeActivationCheckRuntimeModule() ??
    (await import("./facade-activation-check.runtime.js"));
  setFacadeActivationCheckRuntimeModule(module);
  return module;
}

function setFacadeActivationCheckRuntimeForTest(module: FacadeActivationCheckRuntimeModule): void {
  setFacadeActivationCheckRuntimeModule(module);
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

/** Load a bundled or registry-backed plugin public surface, tracking activation ownership. */
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

/** Check whether an activated bundled plugin public surface may be loaded. */
export function canLoadActivatedBundledPluginPublicSurface(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return loadFacadeActivationCheckRuntime().resolveBundledPluginPublicSurfaceAccess(
    buildFacadeActivationCheckParams(params),
  ).allowed;
}

/** Load an activated plugin public surface or throw when activation policy blocks access. */
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

/** Load an activated plugin public surface, returning null when activation policy blocks access. */
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

/** Async variant of tryLoadActivatedBundledPluginPublicSurfaceModuleSync for async call sites. */
export async function tryLoadActivatedBundledPluginPublicSurfaceModule<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): Promise<T | null> {
  const runtime = await loadFacadeActivationCheckRuntimeAsync();
  const access = runtime.resolveBundledPluginPublicSurfaceAccess(
    buildFacadeActivationCheckParams(params),
  );
  if (!access.allowed) {
    return null;
  }
  return loadBundledPluginPublicSurfaceModuleSync<T>(params);
}

/** Reset facade runtime caches and activation-check test overrides. */
export function resetFacadeRuntimeStateForTest(): void {
  resetFacadeLoaderStateForTest();
}

/** Test-only hooks for facade activation and resolution checks. */
export const testing = {
  setFacadeActivationCheckRuntimeForTest,
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
export { testing as __testing };
