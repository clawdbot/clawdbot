// Facade runtime helpers load plugin API facades from installed plugin packages.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { areBundledPluginsDisabled, resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { getPluginCacheRoot, getPluginCacheSource } from "../plugins/plugin-cache.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { getCachedPluginModuleLoader } from "../plugins/plugin-module-loader-cache.js";
import { getPluginRegistryForContext } from "../plugins/runtime-context.js";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";
import {
  loadBundledPluginPublicSurfaceModuleSyncCore as loadBundledPluginPublicSurfaceModuleSyncLight,
  loadFacadeModuleAtLocationSync,
  resolveBundledPublicSurfaceLocation,
  type FacadeModuleLocation,
} from "./facade-loader.js";
import {
  createFacadeResolutionKey as createFacadeResolutionKeyShared,
  resolveBundledMetadataManifestRecord,
  resolveRuntimeFacadeModuleLocation,
  resolveRegistryPluginModuleLocationFromRecords,
  type BundledPluginPublicSurfaceParams,
} from "./facade-resolution-shared.js";
export {
  createLazyFacadeObjectValue,
  listImportedBundledPluginFacadeIds,
  resetFacadeLoaderStateForTest as resetFacadeRuntimeStateForTest,
} from "./facade-loader.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const OPENCLAW_SOURCE_EXTENSIONS_ROOT = path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions");
function createFacadeResolutionKey(params: BundledPluginPublicSurfaceParams): string {
  return createFacadeResolutionKeyShared({
    ...params,
    bundledPluginsDir: resolveBundledPluginsDir(params.env ?? process.env),
  });
}

function resolveFacadeModuleLocationUncached(
  params: BundledPluginPublicSurfaceParams,
): { modulePath: string; boundaryRoot: string } | null {
  const env = params.env ?? process.env;
  if (!areBundledPluginsDisabled(env)) {
    const bundledLocation = resolveBundledPublicSurfaceLocation(params);
    if (bundledLocation) {
      return bundledLocation;
    }
  }
  return loadFacadeActivationCheckRuntime().resolveRegistryPluginModuleLocation(params);
}

function resolveFacadeModuleLocation(
  params: BundledPluginPublicSurfaceParams,
): { modulePath: string; boundaryRoot: string } | null {
  const runtime = resolveRuntimeFacadeModuleLocation(params);
  if (runtime !== undefined) {
    return runtime;
  }
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

function throwFacadeActivationCheckRuntimeUnavailable(): never {
  throw new Error("Unable to load facade activation check runtime");
}

function loadFacadeActivationCheckRuntime(): FacadeActivationCheckRuntimeModule {
  const cached = getFacadeActivationCheckRuntimeModule();
  if (cached) {
    return cached;
  }
  for (const native of [true, false]) {
    for (const candidate of FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES) {
      let loaded: FacadeActivationCheckRuntimeModule;
      try {
        loaded = (
          native
            ? nodeRequire(candidate)
            : getCachedPluginModuleLoader({
                modulePath: candidate,
                importerUrl: import.meta.url,
                loaderFilename: import.meta.url,
                tryNative: false,
              })(candidate)
        ) as FacadeActivationCheckRuntimeModule;
      } catch {
        continue;
      }
      if (loaded) {
        setFacadeActivationCheckRuntimeModule(loaded);
        return loaded;
      }
      // A successful but falsy export ends this loader's candidate search.
      break;
    }
  }
  return throwFacadeActivationCheckRuntimeUnavailable();
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

function buildFacadeActivationCheckParams(
  params: BundledPluginPublicSurfaceParams,
  location: FacadeModuleLocation | null = resolveFacadeModuleLocation(params),
) {
  return {
    ...params,
    location,
    sourceExtensionsRoot: OPENCLAW_SOURCE_EXTENSIONS_ROOT,
  };
}

/** Load a bundled or registry-backed plugin public surface, tracking activation ownership. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic facade loaders use caller-supplied module surface types.
export function loadBundledPluginPublicSurfaceModuleSync<T extends object>(
  params: BundledPluginPublicSurfaceParams,
): T {
  const location = resolveFacadeModuleLocation(params);
  const trackingParams = buildFacadeActivationCheckParams(params, location);
  // Bundled identity is metadata; only registry fallback needs the activation runtime.
  const trackedPluginId = () =>
    resolveBundledMetadataManifestRecord(trackingParams)?.id ??
    loadFacadeActivationCheckRuntime().resolveTrackedFacadePluginId(trackingParams);
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

function wrapActivatedSurface<T extends object>(pluginId: string | undefined, loaded: T): T {
  const owner = getPluginRegistryForContext()?.plugins.find((entry) => entry.id === pluginId);
  return owner ? (getPluginInstance(owner)?.wrap(loaded) ?? loaded) : loaded;
}

/** Load an activated plugin public surface or throw when activation policy blocks access. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic facade loaders use caller-supplied module surface types.
export function loadActivatedBundledPluginPublicSurfaceModuleSync<T extends object>(
  params: BundledPluginPublicSurfaceParams,
): T {
  const access =
    loadFacadeActivationCheckRuntime().resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(
      buildFacadeActivationCheckParams(params),
    );
  return wrapActivatedSurface(access.pluginId, loadBundledPluginPublicSurfaceModuleSync<T>(params));
}

/** Load activation asynchronously; allowed public artifacts still use the synchronous loader. */
export async function loadActivatedBundledPluginPublicSurfaceModule<T extends object>(
  params: BundledPluginPublicSurfaceParams,
): Promise<T> {
  await loadFacadeActivationCheckRuntimeAsync().catch(throwFacadeActivationCheckRuntimeUnavailable);
  return loadActivatedBundledPluginPublicSurfaceModuleSync<T>(params);
}

/** Load an activated plugin public surface, returning null when activation policy blocks access. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic facade loaders use caller-supplied module surface types.
export function tryLoadActivatedBundledPluginPublicSurfaceModuleSync<T extends object>(
  params: BundledPluginPublicSurfaceParams,
): T | null {
  const access = loadFacadeActivationCheckRuntime().resolveBundledPluginPublicSurfaceAccess(
    buildFacadeActivationCheckParams(params),
  );
  if (!access.allowed) {
    return null;
  }
  return wrapActivatedSurface(access.pluginId, loadBundledPluginPublicSurfaceModuleSync<T>(params));
}

/** Async variant of tryLoadActivatedBundledPluginPublicSurfaceModuleSync for async call sites. */
export async function tryLoadActivatedBundledPluginPublicSurfaceModule<T extends object>(
  params: BundledPluginPublicSurfaceParams,
): Promise<T | null> {
  await loadFacadeActivationCheckRuntimeAsync();
  return tryLoadActivatedBundledPluginPublicSurfaceModuleSync<T>(params);
}

/** Test-only hooks for facade activation and resolution checks. */
export const testing = {
  setFacadeActivationCheckRuntimeForTest: setFacadeActivationCheckRuntimeModule,
  loadFacadeModuleAtLocationSync,
  resolveRegistryPluginModuleLocationFromRegistry: resolveRegistryPluginModuleLocationFromRecords,
  resolveFacadeModuleLocation,
};
