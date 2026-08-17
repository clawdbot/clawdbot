/** Resolves the exact root and entry selected by the plugin runtime loader. */
import fs from "node:fs";
import path from "node:path";
import { resolveRealpathOrAbsolute } from "../infra/boundary-path.js";
import type { OpenClawPackageManifest } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistry, requireActivePluginRegistry } from "./runtime.js";

type PluginRuntimeArtifactEntryKind = "runtime" | "setup";

export function clearPluginRuntimeArtifactResolutionMemo(): void {
  getActivePluginRegistry()?.pluginRuntimeArtifacts.clear();
}

/** Canonical packaged runtime replaces staging-only dist-runtime artifacts. */
export function resolveCanonicalDistRuntimeSource(source: string): string {
  const marker = `${path.sep}dist-runtime${path.sep}extensions${path.sep}`;
  const index = source.indexOf(marker);
  if (index === -1) {
    return source;
  }
  const candidate = `${source.slice(0, index)}${path.sep}dist${path.sep}extensions${path.sep}${source.slice(index + marker.length)}`;
  return fs.existsSync(candidate) ? candidate : source;
}

function rewriteBundledRuntimeArtifactRelativePath(relativePath: string): string {
  return relativePath.replace(/\.[^.]+$/u, ".js");
}

function listPackageLocalRuntimeArtifactOutputExtensions(sourceExt: string): string[] {
  switch (sourceExt) {
    case ".mts":
    case ".mjs":
      return [".mjs", ".js", ".cjs"];
    case ".cts":
    case ".cjs":
      return [".cjs", ".js", ".mjs"];
    default:
      return [".js", ".mjs", ".cjs"];
  }
}

function listPackageLocalRuntimeArtifactRelativePathBases(relativePath: string): string[] {
  const ext = path.extname(relativePath).toLowerCase();
  const withoutExt = ext ? relativePath.slice(0, -ext.length) : relativePath;
  if (!withoutExt.startsWith(`src${path.sep}`) && !withoutExt.startsWith("src/")) {
    return [withoutExt];
  }
  return [withoutExt.slice(4), withoutExt];
}

function listPackageLocalDistRuntimeArtifactRelativePaths(relativePath: string): string[] {
  const ext = path.extname(relativePath).toLowerCase();
  const candidates = new Set<string>();
  for (const base of listPackageLocalRuntimeArtifactRelativePathBases(relativePath)) {
    for (const outputExt of listPackageLocalRuntimeArtifactOutputExtensions(ext)) {
      candidates.add(`${base}${outputExt}`);
    }
  }
  return [...candidates];
}

function shouldPreferPackageLocalDistRuntimeArtifact(source: string): boolean {
  switch (path.extname(source).toLowerCase()) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
      return true;
    default:
      return false;
  }
}

function resolvePackageLocalDistRuntimeArtifact(params: {
  source: string;
  rootDir: string;
}): string | null {
  const relativeSource = path.relative(params.rootDir, params.source);
  if (
    !shouldPreferPackageLocalDistRuntimeArtifact(relativeSource) ||
    relativeSource === "" ||
    relativeSource.startsWith("..") ||
    path.isAbsolute(relativeSource)
  ) {
    return null;
  }
  const artifactRoot = path.join(params.rootDir, "dist");
  for (const artifactRelativePath of listPackageLocalDistRuntimeArtifactRelativePaths(
    relativeSource,
  )) {
    const artifactSource = path.join(artifactRoot, artifactRelativePath);
    if (fs.existsSync(artifactSource)) {
      return resolveRealpathOrAbsolute(artifactSource);
    }
  }
  return null;
}

function resolvePreferredBuiltRuntimeArtifact(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  preferBuiltPluginArtifacts: boolean;
  packageManifest?: OpenClawPackageManifest;
}): { source: string; rootDir: string } {
  const rootDir = resolveRealpathOrAbsolute(params.rootDir);
  const source = resolveRealpathOrAbsolute(params.source);
  if (!params.preferBuiltPluginArtifacts) {
    return { source, rootDir };
  }
  if (params.origin !== "bundled") {
    const artifactSource = resolvePackageLocalDistRuntimeArtifact({ source, rootDir });
    if (artifactSource) {
      return { source: artifactSource, rootDir };
    }
    return { source, rootDir };
  }
  // Source-external plugins can leave package-local npm build output behind.
  // Keep source authoritative over that output, but allow the lifecycle-owned root
  // build to provide the fresh JavaScript artifact used by source checkouts.
  const packageLocalArtifactSource =
    params.packageManifest?.build?.bundledDist === false
      ? null
      : resolvePackageLocalDistRuntimeArtifact({ source, rootDir });
  if (packageLocalArtifactSource) {
    return { source: packageLocalArtifactSource, rootDir };
  }
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
  // The runtime overlay is a staging fallback. Final canonicalization maps it
  // to the matching root build when both exist, so one build owns execution.
  for (const artifactRootName of ["dist-runtime", "dist"] as const) {
    const artifactRoot = path.join(
      packageRoot,
      artifactRootName,
      "extensions",
      path.basename(rootDir),
    );
    const artifactSource = path.join(artifactRoot, artifactRelativePath);
    if (fs.existsSync(artifactSource)) {
      return {
        source: resolveRealpathOrAbsolute(artifactSource),
        rootDir: resolveRealpathOrAbsolute(artifactRoot),
      };
    }
  }
  return { source, rootDir };
}

/** Applies both loader selection phases in their runtime order. */
export function resolvePluginRuntimeArtifact(params: {
  pluginId: string;
  entryKind: PluginRuntimeArtifactEntryKind;
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  preferBuiltPluginArtifacts: boolean;
  packageManifest?: OpenClawPackageManifest;
  registry?: PluginRegistry;
}): { source: string; rootDir: string } {
  const rootDir = resolveCanonicalDistRuntimeSource(resolveRealpathOrAbsolute(params.rootDir));
  const source = resolveCanonicalDistRuntimeSource(resolveRealpathOrAbsolute(params.source));
  const memoKey = JSON.stringify([params.pluginId, rootDir, params.entryKind]);
  const targetRegistry = params.registry ?? requireActivePluginRegistry();
  const cached = targetRegistry.pluginRuntimeArtifacts.get(memoKey);
  if (cached) {
    targetRegistry.pluginRuntimeArtifacts.set(memoKey, cached);
    return { ...cached };
  }

  const preferred = resolvePreferredBuiltRuntimeArtifact({ ...params, source, rootDir });
  const resolved = {
    source: resolveCanonicalDistRuntimeSource(preferred.source),
    rootDir: resolveCanonicalDistRuntimeSource(preferred.rootDir),
  };
  targetRegistry.pluginRuntimeArtifacts.set(memoKey, resolved);
  return { ...resolved };
}
