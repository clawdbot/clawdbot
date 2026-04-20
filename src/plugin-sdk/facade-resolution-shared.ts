import fs from "node:fs";
import path from "node:path";
import {
  PUBLIC_SURFACE_SOURCE_EXTENSIONS,
  normalizeBundledPluginArtifactSubpath,
  resolveBundledPluginPublicSurfacePath,
  resolveBundledPluginSourcePublicSurfacePath,
} from "../plugins/public-surface-runtime.js";

export type FacadeModuleLocationLike = {
  modulePath: string;
  boundaryRoot: string;
};

type FacadeRegistryRecordLike = {
  id: string;
  rootDir: string;
  channels: readonly string[];
};

export function createFacadeResolutionKey(params: {
  dirName: string;
  artifactBasename: string;
  bundledPluginsDir?: string | null;
}): string {
  return `${params.dirName}::${params.artifactBasename}::${
    params.bundledPluginsDir ? path.resolve(params.bundledPluginsDir) : "<default>"
  }`;
}

export function resolveCachedFacadeModuleLocation<TLocation>(params: {
  cache: Map<string, TLocation | null>;
  key: string;
  resolve: () => TLocation | null;
}): TLocation | null {
  if (params.cache.has(params.key)) {
    return params.cache.get(params.key) ?? null;
  }
  const resolved = params.resolve();
  params.cache.set(params.key, resolved);
  return resolved;
}

export function resolveFacadeBoundaryRoot(params: {
  modulePath: string;
  bundledPluginsDir?: string | null;
  packageRoot: string;
}): string {
  if (!params.bundledPluginsDir) {
    return params.packageRoot;
  }
  const resolvedBundledPluginsDir = path.resolve(params.bundledPluginsDir);
  return params.modulePath.startsWith(`${resolvedBundledPluginsDir}${path.sep}`)
    ? resolvedBundledPluginsDir
    : params.packageRoot;
}

export function resolveBundledFacadeModuleLocation(params: {
  currentModulePath: string;
  packageRoot: string;
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
  bundledPluginsDir?: string | null;
}): FacadeModuleLocationLike | null {
  const preferSource = !params.currentModulePath.includes(`${path.sep}dist${path.sep}`);
  const publicSurfaceParams = {
    rootDir: params.packageRoot,
    env: params.env,
    ...(params.bundledPluginsDir ? { bundledPluginsDir: params.bundledPluginsDir } : {}),
    dirName: params.dirName,
    artifactBasename: params.artifactBasename,
  };
  const modulePath = preferSource
    ? (resolveBundledPluginSourcePublicSurfacePath({
        dirName: params.dirName,
        artifactBasename: params.artifactBasename,
        sourceRoot: params.bundledPluginsDir ?? path.resolve(params.packageRoot, "extensions"),
      }) ?? resolveBundledPluginPublicSurfacePath(publicSurfaceParams))
    : resolveBundledPluginPublicSurfacePath(publicSurfaceParams);
  return modulePath
    ? {
        modulePath,
        boundaryRoot: resolveFacadeBoundaryRoot({
          modulePath,
          bundledPluginsDir: params.bundledPluginsDir,
          packageRoot: params.packageRoot,
        }),
      }
    : null;
}

export function resolveRegistryPluginModuleLocationFromRecords(params: {
  registry: readonly FacadeRegistryRecordLike[];
  dirName: string;
  artifactBasename: string;
}): FacadeModuleLocationLike | null {
  const tiers: Array<(plugin: FacadeRegistryRecordLike) => boolean> = [
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
