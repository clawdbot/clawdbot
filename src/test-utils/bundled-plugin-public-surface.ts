import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-loader.js";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import {
  findBundledPluginMetadataById,
  type BundledPluginMetadata,
} from "../plugins/bundled-plugin-metadata.js";
import { normalizeBundledPluginArtifactSubpath } from "../plugins/public-surface-runtime.js";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));

type BundledPluginPublicSurfaceMetadata = Pick<BundledPluginMetadata, "dirName">;

function isSafeBundledPluginDirName(pluginId: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/u.test(pluginId);
}

function readPluginManifestId(pluginDir: string): string | undefined {
  try {
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function findBundledPluginMetadataFast(
  pluginId: string,
): BundledPluginPublicSurfaceMetadata | undefined {
  if (!isSafeBundledPluginDirName(pluginId)) {
    return undefined;
  }
  const roots = [
    resolveBundledPluginsDir(),
    path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions"),
    path.resolve(OPENCLAW_PACKAGE_ROOT, "dist-runtime", "extensions"),
    path.resolve(OPENCLAW_PACKAGE_ROOT, "dist", "extensions"),
  ].filter(
    (entry, index, values): entry is string => Boolean(entry) && values.indexOf(entry) === index,
  );

  for (const root of roots) {
    const pluginDir = path.join(root, pluginId);
    if (readPluginManifestId(pluginDir) === pluginId) {
      return { dirName: pluginId };
    }
  }
  return undefined;
}

function findBundledPluginMetadata(pluginId: string): BundledPluginPublicSurfaceMetadata {
  const metadata =
    findBundledPluginMetadataFast(pluginId) ?? findBundledPluginMetadataById(pluginId);
  if (!metadata) {
    throw new Error(`Unknown bundled plugin id: ${pluginId}`);
  }
  return metadata;
}

function readPackageName(packageDir: string): string | undefined {
  try {
    const packageJsonPath = path.join(packageDir, "package.json");
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function resolveWorkspacePackageDir(packageName: string): string {
  const roots = [
    resolveBundledPluginsDir(),
    path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions"),
    path.resolve(OPENCLAW_PACKAGE_ROOT, "dist-runtime", "extensions"),
    path.resolve(OPENCLAW_PACKAGE_ROOT, "dist", "extensions"),
  ].filter(
    (entry, index, values): entry is string => Boolean(entry) && values.indexOf(entry) === index,
  );

  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const packageDir = path.join(root, entry);
      if (readPackageName(packageDir) === packageName) {
        return packageDir;
      }
    }
  }
  throw new Error(`Unknown workspace package: ${packageName}`);
}

export function loadBundledPluginPublicSurfaceSync<T extends object>(params: {
  pluginId: string;
  artifactBasename: string;
}): T {
  const metadata = findBundledPluginMetadata(params.pluginId);
  return loadBundledPluginPublicSurfaceModuleSync<T>({
    dirName: metadata.dirName,
    artifactBasename: normalizeBundledPluginArtifactSubpath(params.artifactBasename),
  });
}

export function loadBundledPluginApiSync<T extends object>(pluginId: string): T {
  return loadBundledPluginPublicSurfaceSync<T>({
    pluginId,
    artifactBasename: "api.js",
  });
}

export function loadBundledPluginContractApiSync<T extends object>(pluginId: string): T {
  return loadBundledPluginPublicSurfaceSync<T>({
    pluginId,
    artifactBasename: "contract-api.js",
  });
}

export function loadBundledPluginRuntimeApiSync<T extends object>(pluginId: string): T {
  return loadBundledPluginPublicSurfaceSync<T>({
    pluginId,
    artifactBasename: "runtime-api.js",
  });
}

export function loadBundledPluginTestApiSync<T extends object>(pluginId: string): T {
  return loadBundledPluginPublicSurfaceSync<T>({
    pluginId,
    artifactBasename: "test-api.js",
  });
}

export function resolveBundledPluginPublicModulePath(params: {
  pluginId: string;
  artifactBasename: string;
}): string {
  const metadata = findBundledPluginMetadata(params.pluginId);
  return path.resolve(
    OPENCLAW_PACKAGE_ROOT,
    "extensions",
    metadata.dirName,
    normalizeBundledPluginArtifactSubpath(params.artifactBasename),
  );
}

function resolveVitestSourceModulePath(targetPath: string): string {
  if (!targetPath.endsWith(".js")) {
    return targetPath;
  }
  const sourcePath = `${targetPath.slice(0, -".js".length)}.ts`;
  return pathExists(sourcePath) ? sourcePath : targetPath;
}

function pathExists(filePath: string): boolean {
  try {
    return Boolean(filePath) && path.isAbsolute(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolveRelativeBundledPluginPublicModuleId(params: {
  fromModuleUrl: string;
  pluginId: string;
  artifactBasename: string;
}): string {
  const fromFilePath = fileURLToPath(params.fromModuleUrl);
  const targetPath = resolveVitestSourceModulePath(
    resolveBundledPluginPublicModulePath({
      pluginId: params.pluginId,
      artifactBasename: params.artifactBasename,
    }),
  );
  const relativePath = path
    .relative(path.dirname(fromFilePath), targetPath)
    .replaceAll(path.sep, "/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

export function resolveRelativeExtensionPublicModuleId(params: {
  fromModuleUrl: string;
  dirName: string;
  artifactBasename: string;
}): string {
  const fromFilePath = fileURLToPath(params.fromModuleUrl);
  const targetPath = resolveVitestSourceModulePath(
    path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions", params.dirName, params.artifactBasename),
  );
  const relativePath = path
    .relative(path.dirname(fromFilePath), targetPath)
    .replaceAll(path.sep, "/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

export function resolveRelativeWorkspacePackagePublicModuleId(params: {
  fromModuleUrl: string;
  packageName: string;
  artifactBasename: string;
}): string {
  const fromFilePath = fileURLToPath(params.fromModuleUrl);
  const targetPath = resolveVitestSourceModulePath(
    path.resolve(
      resolveWorkspacePackageDir(params.packageName),
      normalizeBundledPluginArtifactSubpath(params.artifactBasename),
    ),
  );
  const relativePath = path
    .relative(path.dirname(fromFilePath), targetPath)
    .replaceAll(path.sep, "/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}
