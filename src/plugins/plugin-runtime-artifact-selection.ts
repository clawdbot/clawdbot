/** Selects built plugin artifacts without importing active runtime state. */
import path from "node:path";
import type { OpenClawPackageManifest } from "./manifest.js";
import {
  isTypeScriptPackageEntry,
  listBuiltRuntimeEntryCandidates,
} from "./package-entrypoints.js";
import { pluginCacheExistsSync, pluginCacheRealpathSync } from "./plugin-cache-files.js";
import { getPluginCacheRoot } from "./plugin-cache.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

function rewriteBundledRuntimeArtifactRelativePath(relativePath: string): string {
  return relativePath.replace(/\.[^.]+$/u, ".js");
}

function resolvePackageLocalDistRuntimeArtifact(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
}): string | null {
  const relativeSource = path.relative(params.rootDir, params.source);
  if (
    !isTypeScriptPackageEntry(relativeSource) ||
    relativeSource === "" ||
    relativeSource.startsWith("..") ||
    path.isAbsolute(relativeSource)
  ) {
    return null;
  }
  for (const artifactRelativePath of listBuiltRuntimeEntryCandidates(relativeSource)) {
    // Bundled source peers must not shadow the canonical root build below.
    if (params.origin === "bundled" && !artifactRelativePath.startsWith("./dist/")) {
      continue;
    }
    const artifactSource = path.resolve(params.rootDir, artifactRelativePath);
    if (pluginCacheExistsSync(artifactSource)) {
      return pluginCacheRealpathSync(artifactSource) ?? path.resolve(artifactSource);
    }
  }
  return null;
}

function resolvePreferredBundledRootArtifactFromCanonicalPaths(params: {
  source: string;
  rootDir: string;
  packageManifest?: OpenClawPackageManifest;
}): { source: string; rootDir: string } {
  const { rootDir, source } = params;
  const sourceExternal = params.packageManifest?.build?.bundledDist === false;
  const extensionsDir = path.dirname(rootDir);
  if (path.basename(extensionsDir) !== "extensions") {
    return { source, rootDir };
  }
  const packageRoot = path.dirname(extensionsDir);
  if (path.basename(packageRoot) === "dist" || path.basename(packageRoot) === "dist-runtime") {
    return { source, rootDir };
  }
  const relativeSource = path.relative(rootDir, source);
  if (relativeSource === "" || relativeSource.startsWith("..") || path.isAbsolute(relativeSource)) {
    return { source, rootDir };
  }
  const artifactRelativePath = rewriteBundledRuntimeArtifactRelativePath(relativeSource);
  // Source-external packaging can replace the flat root build while leaving its
  // staging wrapper behind, so only bundled artifacts may fall back to dist-runtime.
  for (const artifactRootName of sourceExternal ? ["dist"] : ["dist-runtime", "dist"]) {
    const artifactRoot = path.join(
      packageRoot,
      artifactRootName,
      "extensions",
      path.basename(rootDir),
    );
    const artifactSource = path.join(artifactRoot, artifactRelativePath);
    if (pluginCacheExistsSync(artifactSource)) {
      return {
        source: pluginCacheRealpathSync(artifactSource) ?? path.resolve(artifactSource),
        rootDir: pluginCacheRealpathSync(artifactRoot) ?? path.resolve(artifactRoot),
      };
    }
  }
  return { source, rootDir };
}

/** Selects the lifecycle-owned root build for one bundled source artifact. */
export function resolvePreferredBundledRootArtifact(params: {
  source: string;
  rootDir: string;
  packageManifest?: OpenClawPackageManifest;
}): { source: string; rootDir: string } {
  const artifacts = getPluginCacheRoot(params.rootDir).runtimeArtifacts;
  const key = JSON.stringify([
    "bundled-root",
    params.source,
    params.packageManifest?.build?.bundledDist,
  ]);
  const cached = artifacts.get(key);
  if (cached) {
    return cached;
  }
  const resolved = resolvePreferredBundledRootArtifactFromCanonicalPaths({
    source: pluginCacheRealpathSync(params.source) ?? path.resolve(params.source),
    rootDir: pluginCacheRealpathSync(params.rootDir) ?? path.resolve(params.rootDir),
    packageManifest: params.packageManifest,
  });
  artifacts.set(key, resolved);
  return resolved;
}

/** Applies source, package-local, and root-build preference without runtime memo state. */
export function resolvePreferredBuiltRuntimeArtifact(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  preferBuiltPluginArtifacts: boolean;
  packageManifest?: OpenClawPackageManifest;
}): { source: string; rootDir: string } {
  // The stateful resolver canonicalizes both paths before memo-key construction.
  const { rootDir, source } = params;
  if (!params.preferBuiltPluginArtifacts) {
    return { source, rootDir };
  }
  if (params.origin !== "bundled") {
    const artifactSource = resolvePackageLocalDistRuntimeArtifact({ ...params, source, rootDir });
    return artifactSource ? { source: artifactSource, rootDir } : { source, rootDir };
  }
  // Source-external plugins keep source authoritative over package-local output;
  // only the lifecycle-owned canonical root build may replace that pair.
  const sourceExternal = params.packageManifest?.build?.bundledDist === false;
  const packageLocalArtifactSource = sourceExternal
    ? null
    : resolvePackageLocalDistRuntimeArtifact({ ...params, source, rootDir });
  if (packageLocalArtifactSource) {
    return { source: packageLocalArtifactSource, rootDir };
  }
  return resolvePreferredBundledRootArtifactFromCanonicalPaths({
    source,
    rootDir,
    packageManifest: params.packageManifest,
  });
}
