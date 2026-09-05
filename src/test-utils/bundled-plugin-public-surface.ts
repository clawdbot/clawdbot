// Test helper for asserting bundled plugin public surface files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { loadBundledPluginPublicSurfaceModule } from "../plugin-sdk/facade-loader.js";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { findBundledPluginMetadataById } from "../plugins/bundled-plugin-metadata.js";
import { resolveBundledPluginSourcePublicSurfacePath } from "../plugins/public-surface-runtime.js";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));

type BundledPluginPublicSurfaceMetadata = Pick<
  NonNullable<ReturnType<typeof findBundledPluginMetadataById>>,
  "dirName"
>;
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
  const rawRoots = [
    resolveBundledPluginsDir(),
    path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions"),
    path.resolve(OPENCLAW_PACKAGE_ROOT, "dist-runtime", "extensions"),
    path.resolve(OPENCLAW_PACKAGE_ROOT, "dist", "extensions"),
  ].filter((entry): entry is string => Boolean(entry));
  const roots = uniqueStrings(rawRoots);

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

type AsyncBundledPluginPublicSurfaceLoader = <T extends object>(params: {
  pluginId: string;
  artifactBasename: string;
}) => Promise<T>;

export const loadBundledPluginFacade: AsyncBundledPluginPublicSurfaceLoader = (params) => {
  const metadata = findBundledPluginMetadata(params.pluginId);
  return loadBundledPluginPublicSurfaceModule({
    dirName: metadata.dirName,
    artifactBasename: params.artifactBasename,
  });
};

export function resolveBundledPluginPublicModulePath(params: {
  pluginId: string;
  artifactBasename: string;
}): string {
  const metadata = findBundledPluginMetadata(params.pluginId);
  const sourceRoot = path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions");
  const sourcePath = resolveBundledPluginSourcePublicSurfacePath({
    sourceRoot,
    dirName: metadata.dirName,
    artifactBasename: params.artifactBasename,
  });
  // Optional contract callers need the validated path even when no artifact exists.
  return sourcePath ?? path.resolve(sourceRoot, metadata.dirName, params.artifactBasename);
}

export function resolveRelativeBundledPluginPublicModuleId(params: {
  fromModuleUrl: string;
  pluginId: string;
  artifactBasename: string;
}): string {
  const fromFilePath = fileURLToPath(params.fromModuleUrl);
  const targetPath = resolveBundledPluginPublicModulePath({
    pluginId: params.pluginId,
    artifactBasename: params.artifactBasename,
  });
  const relativePath = path
    .relative(path.dirname(fromFilePath), targetPath)
    .replaceAll(path.sep, "/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}
