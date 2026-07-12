/** Resolves the exact root and entry selected by the plugin runtime loader. */
import fs from "node:fs";
import path from "node:path";
import type { OpenClawPackageManifest } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

function safeRealpathOrResolve(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
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
      return safeRealpathOrResolve(artifactSource);
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
  const rootDir = safeRealpathOrResolve(params.rootDir);
  const source = safeRealpathOrResolve(params.source);
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
  if (params.packageManifest?.build?.bundledDist === false) {
    return { source, rootDir };
  }
  const packageLocalArtifactSource = resolvePackageLocalDistRuntimeArtifact({ source, rootDir });
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
        source: safeRealpathOrResolve(artifactSource),
        rootDir: safeRealpathOrResolve(artifactRoot),
      };
    }
  }
  return { source, rootDir };
}

/** Applies both loader selection phases in their runtime order. */
export function resolvePluginRuntimeArtifact(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  preferBuiltPluginArtifacts: boolean;
  packageManifest?: OpenClawPackageManifest;
}): { source: string; rootDir: string } {
  const preferred = resolvePreferredBuiltRuntimeArtifact(params);
  return {
    source: resolveCanonicalDistRuntimeSource(preferred.source),
    rootDir: resolveCanonicalDistRuntimeSource(preferred.rootDir),
  };
}
