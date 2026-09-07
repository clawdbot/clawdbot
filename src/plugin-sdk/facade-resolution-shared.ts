/**
 * Shared resolver for bundled plugin facade module paths and registry fallbacks.
 */
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { areBundledPluginsDisabled, resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { parsePluginCacheJson, readPluginCacheFile } from "../plugins/plugin-cache-files.js";
import {
  normalizeBundledPluginArtifactSubpath,
  resolveBundledPluginPublicSurfacePath,
  resolveBundledPluginSourcePublicSurfacePath,
  resolvePluginRootPublicSurfacePath,
} from "../plugins/public-surface-runtime.js";

/** Resolved facade module path plus the package/plugin root that bounds imports. */
export type FacadeModuleLocationLike = {
  modulePath: string;
  boundaryRoot: string;
};

type FacadeRegistryRecordLike = {
  id: string;
  rootDir: string;
  channels: readonly string[];
};

/** Minimal manifest shape shared by facade identity tracking and activation checks. */
export type FacadePluginManifestLike = Pick<
  PluginManifestRecord,
  "id" | "origin" | "enabledByDefault" | "enabledByDefaultOnPlatforms" | "rootDir" | "channels"
>;

function readBundledPluginManifestRecordFromDir(params: {
  pluginsRoot: string;
  resolvedDirName: string;
}): FacadePluginManifestLike | null {
  const file = readPluginCacheFile({
    rootDir: path.join(params.pluginsRoot, params.resolvedDirName),
    relativePath: "openclaw.plugin.json",
    rejectHardlinks: false,
  });
  if (!file.ok) {
    return null;
  }
  try {
    const parsed = parsePluginCacheJson(file, { json5: true });
    if (!parsed.ok || !isRecord(parsed.value)) {
      return null;
    }
    const raw = parsed.value;
    if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
      return null;
    }
    return {
      id: raw.id,
      origin: "bundled",
      enabledByDefault: raw.enabledByDefault === true,
      rootDir: path.join(params.pluginsRoot, params.resolvedDirName),
      channels: Array.isArray(raw.channels)
        ? raw.channels.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/** Resolve bundled facade metadata without importing activation or registry runtime. */
export function resolveBundledMetadataManifestRecord(params: {
  dirName: string;
  artifactBasename: string;
  location: FacadeModuleLocationLike | null;
  sourceExtensionsRoot: string;
  env?: NodeJS.ProcessEnv;
}): FacadePluginManifestLike | null {
  if (!params.location) {
    return null;
  }
  if (params.location.modulePath.startsWith(`${params.sourceExtensionsRoot}${path.sep}`)) {
    const relativeToExtensions = path.relative(
      params.sourceExtensionsRoot,
      params.location.modulePath,
    );
    const resolvedDirName = relativeToExtensions.split(path.sep)[0];
    if (!resolvedDirName) {
      return null;
    }
    return readBundledPluginManifestRecordFromDir({
      pluginsRoot: params.sourceExtensionsRoot,
      resolvedDirName,
    });
  }
  const bundledPluginsDir = resolveBundledPluginsDir(params.env ?? process.env);
  if (!bundledPluginsDir) {
    return null;
  }
  const normalizedBundledPluginsDir = path.resolve(bundledPluginsDir);
  if (!params.location.modulePath.startsWith(`${normalizedBundledPluginsDir}${path.sep}`)) {
    return null;
  }
  const relativeToBundledDir = path.relative(
    normalizedBundledPluginsDir,
    params.location.modulePath,
  );
  const resolvedDirName = relativeToBundledDir.split(path.sep)[0];
  if (!resolvedDirName) {
    return null;
  }
  return readBundledPluginManifestRecordFromDir({
    pluginsRoot: normalizedBundledPluginsDir,
    resolvedDirName,
  });
}

/** Builds the cache key for one facade lookup under the current bundled-plugin mode. */
export function createFacadeResolutionKey(params: {
  dirName: string;
  artifactBasename: string;
  bundledPluginsDir?: string | null;
  env?: NodeJS.ProcessEnv;
}): string {
  const disabledKey = areBundledPluginsDisabled(params.env ?? process.env) ? "disabled" : "enabled";
  return `${params.dirName}::${params.artifactBasename}::${
    params.bundledPluginsDir ? path.resolve(params.bundledPluginsDir) : "<default>"
  }::${disabledKey}`;
}

/** Chooses the boundary root that should constrain a resolved facade module. */
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

/** Resolves a bundled facade from source in dev and built artifacts in dist installs. */
export function resolveBundledFacadeModuleLocation(params: {
  currentModulePath: string;
  packageRoot: string;
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
  bundledPluginsDir?: string | null;
}): FacadeModuleLocationLike | null {
  const env = params.env ?? process.env;
  if (areBundledPluginsDisabled(env)) {
    return null;
  }
  const preferSource = !params.currentModulePath.includes(`${path.sep}dist${path.sep}`);
  const packageSourceRoot = path.resolve(params.packageRoot, "extensions");
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
        sourceRoot: params.bundledPluginsDir ?? packageSourceRoot,
      }) ??
      (params.bundledPluginsDir && !areBundledPluginsDisabled(env)
        ? resolveBundledPluginSourcePublicSurfacePath({
            dirName: params.dirName,
            artifactBasename: params.artifactBasename,
            sourceRoot: packageSourceRoot,
          })
        : null) ??
      resolveBundledPluginPublicSurfacePath(publicSurfaceParams))
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

/** Resolves a facade path from manifest registry records using id, folder, then channel matches. */
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
  for (const matchFn of tiers) {
    for (const record of params.registry.filter(matchFn)) {
      const rootDir = path.resolve(record.rootDir);
      const modulePath = resolvePluginRootPublicSurfacePath({
        pluginRoot: rootDir,
        artifactBasename,
      });
      if (modulePath) {
        return { modulePath, boundaryRoot: rootDir };
      }
    }
  }
  return null;
}
