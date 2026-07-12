// Loads documented plugin public surfaces while preserving lazy boundaries.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { sameFileIdentity } from "../infra/fs-safe-advanced.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginModuleLoader,
  type PluginModuleLoaderCache,
} from "./plugin-module-loader-cache.js";
import {
  resolveBundledPluginPublicSurfacePath,
  resolvePluginRootPublicSurfacePath,
} from "./public-surface-runtime.js";
import { resolvePluginLoaderTryNative, resolveLoaderPackageRoot } from "./sdk-alias.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
const publicSurfaceModuleCache = new Map<string, unknown>();
const sourceArtifactRequire = createRequire(import.meta.url);
const publicSurfaceLocationCache = new Map<
  string,
  {
    modulePath: string;
    boundaryRoot: string;
  }
>();
const moduleLoaders: PluginModuleLoaderCache = createPluginModuleLoaderCache();

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
    ...(bundledPluginsDir ? { bundledPluginsDir, bundledPluginsDirMode: "explicit" as const } : {}),
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
  const cached = publicSurfaceLocationCache.get(key);
  if (cached) {
    return cached;
  }
  const resolved = resolvePublicSurfaceLocationUncached(params);
  if (resolved) {
    publicSurfaceLocationCache.set(key, resolved);
  }
  return resolved;
}

function getModuleLoader(modulePath: string) {
  return getCachedPluginModuleLoader({
    cache: moduleLoaders,
    modulePath,
    importerUrl: import.meta.url,
    preferBuiltDist: true,
    loaderFilename: import.meta.url,
  });
}

function loadPublicSurfaceModule(modulePath: string): unknown {
  const tryNative = resolvePluginLoaderTryNative(modulePath, { preferBuiltDist: true });
  if (canUseSourceArtifactRequire({ modulePath, tryNative })) {
    return sourceArtifactRequire(modulePath);
  }
  return getModuleLoader(modulePath)(modulePath);
}

function loadValidatedPublicSurfaceModule(params: {
  modulePath: string;
  boundaryRoot: string;
  boundaryLabel: string;
  surfaceLabel: string;
}): object {
  const cached = publicSurfaceModuleCache.get(params.modulePath);
  if (cached) {
    return cached as object;
  }

  const opened = openRootFileSync({
    absolutePath: params.modulePath,
    rootPath: params.boundaryRoot,
    boundaryLabel: params.boundaryLabel,
    rejectHardlinks: false,
  });
  if (!opened.ok) {
    throw new Error(`Unable to open ${params.surfaceLabel}`, { cause: opened.error });
  }
  const validatedPath = opened.path;
  const validatedStat = opened.stat;
  fs.closeSync(opened.fd);

  const currentStat = fs.statSync(validatedPath);
  if (!sameFileIdentity(validatedStat, currentStat)) {
    throw new Error(`${params.surfaceLabel} changed after validation`);
  }

  const sentinel: Record<string, unknown> = {};
  publicSurfaceModuleCache.set(params.modulePath, sentinel);
  publicSurfaceModuleCache.set(validatedPath, sentinel);
  try {
    const loaded = loadPublicSurfaceModule(validatedPath) as object;
    Object.assign(sentinel, loaded);
    return sentinel;
  } catch (error) {
    publicSurfaceModuleCache.delete(params.modulePath);
    publicSurfaceModuleCache.delete(validatedPath);
    throw error;
  }
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
  return loadValidatedPublicSurfaceModule({
    modulePath: location.modulePath,
    boundaryRoot: location.boundaryRoot,
    boundaryLabel:
      location.boundaryRoot === OPENCLAW_PACKAGE_ROOT ? "OpenClaw package root" : "plugin root",
    surfaceLabel: `bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
  }) as T;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadPluginPublicArtifactModuleSync<T extends object>(params: {
  pluginRoot: string;
  artifactBasename: string;
}): T {
  const modulePath = resolvePluginRootPublicSurfacePath(params);
  if (!modulePath) {
    throw new Error(
      `Unable to resolve plugin public surface ${params.pluginRoot}/${params.artifactBasename}`,
    );
  }
  return loadValidatedPublicSurfaceModule({
    modulePath,
    boundaryRoot: path.resolve(params.pluginRoot),
    boundaryLabel: "plugin root",
    surfaceLabel: `plugin public surface ${params.artifactBasename}`,
  }) as T;
}

/** Loads the first resolvable bundled public artifact from an ordered candidate list. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadBundledPluginPublicArtifactModuleFromCandidatesSync<T extends object>(params: {
  dirName: string;
  artifactCandidates: readonly string[];
}): T | null {
  for (const artifactBasename of params.artifactCandidates) {
    try {
      return loadBundledPluginPublicArtifactModuleSync<T>({
        dirName: params.dirName,
        artifactBasename,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

export function resetBundledPluginPublicArtifactLoaderForTest(): void {
  publicSurfaceModuleCache.clear();
  publicSurfaceLocationCache.clear();
  moduleLoaders.clear();
}
