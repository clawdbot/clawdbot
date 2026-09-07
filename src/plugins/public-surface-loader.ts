// Loads documented plugin public surfaces while preserving lazy boundaries.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MissingPublicSurfaceError } from "../plugin-sdk/facade-loader.js";
import { areBundledPluginsDisabled, resolveBundledPluginsDir } from "./bundled-dir.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { getPluginCacheRoot } from "./plugin-cache.js";
import {
  getCachedPluginModuleLoader,
  loadPluginPublicSurfaceModuleSync,
} from "./plugin-module-loader-cache.js";
import {
  resolveBundledPluginPublicSurfacePath,
  resolvePluginRootPublicSurfacePath,
} from "./public-surface-runtime.js";
import { resolveLoaderPackageRoot } from "./sdk-alias.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
type PublicSurfaceLocation = {
  modulePath: string;
  boundaryRoot: string;
};

function createResolutionKey(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const bundledPluginsDir = resolveBundledPluginsDir(params.env);
  return `${params.dirName}::${params.artifactBasename}::${areBundledPluginsDisabled(params.env)}::${bundledPluginsDir ? path.resolve(bundledPluginsDir) : "<default>"}`;
}

function resolvePublicSurfaceLocationUncached(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): PublicSurfaceLocation | null {
  const bundledPluginsDir = resolveBundledPluginsDir(params.env);
  const modulePath = resolveBundledPluginPublicSurfacePath({
    rootDir: OPENCLAW_PACKAGE_ROOT,
    ...(bundledPluginsDir ? { bundledPluginsDir, bundledPluginsDirMode: "explicit" as const } : {}),
    dirName: params.dirName,
    artifactBasename: params.artifactBasename,
    env: params.env,
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
  env?: NodeJS.ProcessEnv;
}): PublicSurfaceLocation | null {
  const key = createResolutionKey(params);
  const artifacts = getPluginCacheRoot(OPENCLAW_PACKAGE_ROOT).artifacts;
  const cached = artifacts.get(`public:${key}`);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = resolvePublicSurfaceLocationUncached(params);
  artifacts.set(`public:${key}`, resolved);
  return resolved;
}

function loadPublicSurfaceModule(modulePath: string): unknown {
  // A TS require hook can force import-only dependencies through CommonJS resolution.
  // Keep source transforms and built-artifact native loading on the same canonical owner.
  const load = getCachedPluginModuleLoader({
    modulePath,
    importerUrl: import.meta.url,
    preferBuiltDist: true,
    loaderFilename: import.meta.url,
  });
  return load(modulePath);
}

function loadValidatedPublicSurfaceModule(params: {
  modulePath: string;
  boundaryRoot: string;
  boundaryLabel: string;
  surfaceLabel: string;
  origin: "bundled" | "global";
}): object {
  return loadPluginPublicSurfaceModuleSync({
    ...params,
    rejectHardlinks: shouldRejectHardlinkedPluginFiles({
      origin: params.origin,
      rootDir: params.boundaryRoot,
    }),
    loadModule: loadPublicSurfaceModule,
  });
}

function loadBundledPublicSurfaceAtLocation(params: {
  dirName: string;
  artifactBasename: string;
  location: PublicSurfaceLocation;
}): object {
  return loadValidatedPublicSurfaceModule({
    modulePath: params.location.modulePath,
    boundaryRoot: params.location.boundaryRoot,
    boundaryLabel:
      params.location.boundaryRoot === OPENCLAW_PACKAGE_ROOT
        ? "OpenClaw package root"
        : "plugin root",
    surfaceLabel: `bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
    origin: "bundled",
  });
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadBundledPluginPublicArtifactModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): T {
  const location = resolvePublicSurfaceLocation(params);
  if (!location) {
    throw new MissingPublicSurfaceError(
      `Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
    );
  }
  return loadBundledPublicSurfaceAtLocation({ ...params, location }) as T;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadPluginPublicArtifactModuleSync<T extends object>(params: {
  pluginRoot: string;
  artifactBasename: string;
  origin?: "bundled" | "global";
}): T {
  const root = getPluginCacheRoot(params.pluginRoot);
  const key = `public:${params.artifactBasename}`;
  let location = root.artifacts.get(key);
  if (location === undefined) {
    const modulePath = resolvePluginRootPublicSurfacePath(params);
    location = modulePath ? { modulePath, boundaryRoot: root.rootDir } : null;
    root.artifacts.set(key, location);
  }
  if (!location) {
    throw new MissingPublicSurfaceError(
      `Unable to resolve plugin public surface ${params.pluginRoot}/${params.artifactBasename}`,
    );
  }
  return loadValidatedPublicSurfaceModule({
    ...location,
    boundaryLabel: "plugin root",
    surfaceLabel: `plugin public surface ${params.artifactBasename}`,
    origin: params.origin ?? "global",
  }) as T;
}

/** Loads the first resolvable bundled public artifact from an ordered candidate list. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadBundledPluginPublicArtifactModuleFromCandidatesSync<T extends object>(params: {
  dirName: string;
  artifactCandidates: readonly string[];
  env?: NodeJS.ProcessEnv;
}): T | null {
  for (const artifactBasename of params.artifactCandidates) {
    const location = resolvePublicSurfaceLocation({
      dirName: params.dirName,
      artifactBasename,
      env: params.env,
    });
    if (location) {
      return loadBundledPublicSurfaceAtLocation({
        dirName: params.dirName,
        artifactBasename,
        location,
      }) as T;
    }
  }
  return null;
}
