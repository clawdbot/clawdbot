import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { sameFileIdentity } from "../infra/file-identity.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { getCachedPluginJitiLoader, type PluginJitiLoaderCache } from "./jiti-loader-cache.js";
import { resolveBundledPluginPublicSurfacePath } from "./public-surface-runtime.js";
import {
  isBundledPluginExtensionPath,
  resolvePluginLoaderJitiTryNative,
  resolveLoaderPackageRoot,
} from "./sdk-alias.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
const loadedPublicSurfaceModules = new Map<string, unknown>();
const sourceArtifactRequire = createRequire(import.meta.url);
const publicSurfaceLocations = new Map<
  string,
  {
    modulePath: string;
    boundaryRoot: string;
  } | null
>();
const jitiLoaders: PluginJitiLoaderCache = new Map();
const sharedBundledPublicSurfaceJitiLoaders: PluginJitiLoaderCache = new Map();

function isSourceArtifactPath(modulePath: string): boolean {
  switch (path.extname(modulePath).toLowerCase()) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
    case ".mtsx":
    case ".ctsx":
      return true;
    default:
      return false;
  }
}

function canUseSourceArtifactRequire(params: { modulePath: string; tryNative: boolean }): boolean {
  return (
    !params.tryNative &&
    isSourceArtifactPath(params.modulePath) &&
    typeof sourceArtifactRequire.extensions?.[".ts"] === "function"
  );
}

function createResolutionKey(params: { dirName: string; artifactBasename: string }): string {
  const bundledPluginsDir = resolveBundledPluginsDir();
  return `${params.dirName}::${params.artifactBasename}::${bundledPluginsDir ? path.resolve(bundledPluginsDir) : "<default>"}`;
}

function resolvePublicSurfaceLocationUncached(params: {
  dirName: string;
  artifactBasename: string;
}): { modulePath: string; boundaryRoot: string } | null {
  const bundledPluginsDir = resolveBundledPluginsDir();
  const modulePath = resolveBundledPluginPublicSurfacePath({
    rootDir: OPENCLAW_PACKAGE_ROOT,
    ...(bundledPluginsDir ? { bundledPluginsDir } : {}),
    dirName: params.dirName,
    artifactBasename: params.artifactBasename,
  });
  if (!modulePath) {
    return null;
  }
  return {
    modulePath,
    boundaryRoot:
      bundledPluginsDir && modulePath.startsWith(path.resolve(bundledPluginsDir) + path.sep)
        ? path.resolve(bundledPluginsDir)
        : OPENCLAW_PACKAGE_ROOT,
  };
}

function resolvePublicSurfaceLocation(params: {
  dirName: string;
  artifactBasename: string;
}): { modulePath: string; boundaryRoot: string } | null {
  const key = createResolutionKey(params);
  if (publicSurfaceLocations.has(key)) {
    return publicSurfaceLocations.get(key) ?? null;
  }
  const resolved = resolvePublicSurfaceLocationUncached(params);
  publicSurfaceLocations.set(key, resolved);
  return resolved;
}

function getJiti(modulePath: string) {
  const tryNative = resolvePluginLoaderJitiTryNative(modulePath, { preferBuiltDist: true });
  const sharedLoader = getSharedBundledPublicSurfaceJiti(modulePath, tryNative);
  if (sharedLoader) {
    return sharedLoader;
  }
  const loader = getCachedPluginJitiLoader({
    cache: jitiLoaders,
    modulePath,
    importerUrl: import.meta.url,
    preferBuiltDist: true,
    jitiFilename: import.meta.url,
  });
  return loader;
}

function loadPublicSurfaceModule(modulePath: string): unknown {
  const tryNative = resolvePluginLoaderJitiTryNative(modulePath, { preferBuiltDist: true });
  if (canUseSourceArtifactRequire({ modulePath, tryNative })) {
    return sourceArtifactRequire(modulePath);
  }
  return getJiti(modulePath)(modulePath);
}

function getSharedBundledPublicSurfaceJiti(modulePath: string, tryNative: boolean) {
  const bundledPluginsDir = resolveBundledPluginsDir();
  if (
    !isBundledPluginExtensionPath({
      modulePath,
      openClawPackageRoot: OPENCLAW_PACKAGE_ROOT,
      ...(bundledPluginsDir ? { bundledPluginsDir } : {}),
    })
  ) {
    return null;
  }
  const cacheKey = tryNative ? "bundled:native" : "bundled:source";
  return getCachedPluginJitiLoader({
    cache: sharedBundledPublicSurfaceJitiLoaders,
    modulePath,
    importerUrl: import.meta.url,
    jitiFilename: import.meta.url,
    cacheScopeKey: cacheKey,
    tryNative,
  });
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadBundledPluginPublicArtifactModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
}): T {
  const location = resolvePublicSurfaceLocation(params);
  if (!location) {
    throw new Error(
      `Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
    );
  }
  const cached = loadedPublicSurfaceModules.get(location.modulePath);
  if (cached) {
    return cached as T;
  }

  const opened = openBoundaryFileSync({
    absolutePath: location.modulePath,
    rootPath: location.boundaryRoot,
    boundaryLabel:
      location.boundaryRoot === OPENCLAW_PACKAGE_ROOT
        ? "OpenClaw package root"
        : "bundled plugin directory",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    throw new Error(
      `Unable to open bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
      { cause: opened.error },
    );
  }
  const validatedPath = opened.path;
  const validatedStat = opened.stat;
  fs.closeSync(opened.fd);

  const currentStat = fs.statSync(validatedPath);
  if (!sameFileIdentity(validatedStat, currentStat)) {
    throw new Error(
      `Bundled plugin public surface changed after validation: ${params.dirName}/${params.artifactBasename}`,
    );
  }

  const sentinel = {} as T;
  loadedPublicSurfaceModules.set(location.modulePath, sentinel);
  loadedPublicSurfaceModules.set(validatedPath, sentinel);
  try {
    const loaded = loadPublicSurfaceModule(validatedPath) as T;
    Object.assign(sentinel, loaded);
    return sentinel;
  } catch (error) {
    loadedPublicSurfaceModules.delete(location.modulePath);
    loadedPublicSurfaceModules.delete(validatedPath);
    throw error;
  }
}

export function resolveBundledPluginPublicArtifactPath(params: {
  dirName: string;
  artifactBasename: string;
}): string | null {
  return resolvePublicSurfaceLocation(params)?.modulePath ?? null;
}

export function resetBundledPluginPublicArtifactLoaderForTest(): void {
  loadedPublicSurfaceModules.clear();
  publicSurfaceLocations.clear();
  jitiLoaders.clear();
  sharedBundledPublicSurfaceJitiLoaders.clear();
}
