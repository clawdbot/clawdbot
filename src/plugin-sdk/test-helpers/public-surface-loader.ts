import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function normalizeArtifactBasename(artifactBasename: string): string {
  return artifactBasename.replace(/^\.\/+/u, "").replace(/^\/+/u, "");
}

function resolveSourceArtifactPath(packageDir: string, artifactBasename: string): string {
  const artifactPath = path.resolve(packageDir, normalizeArtifactBasename(artifactBasename));
  if (artifactPath.endsWith(".js")) {
    const sourcePath = `${artifactPath.slice(0, -".js".length)}.ts`;
    if (fs.existsSync(sourcePath)) {
      return sourcePath;
    }
  }
  return artifactPath;
}

function resolveExtensionDirByManifestId(pluginId: string): string {
  const pluginDir = path.resolve(repoRoot, "extensions", pluginId);
  const manifest = readJson(path.join(pluginDir, "openclaw.plugin.json")) as
    | { id?: unknown }
    | undefined;
  if (manifest?.id === pluginId) {
    return pluginDir;
  }
  throw new Error(`Unknown bundled plugin id: ${pluginId}`);
}

function resolveWorkspacePackageDir(packageName: string): string {
  const extensionsDir = path.resolve(repoRoot, "extensions");
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDir = path.join(extensionsDir, entry.name);
    const manifest = readJson(path.join(packageDir, "package.json")) as
      | { name?: unknown }
      | undefined;
    if (manifest?.name === packageName) {
      return packageDir;
    }
  }
  throw new Error(`Unknown workspace package: ${packageName}`);
}

type AsyncBundledPluginPublicSurfaceLoader = <T extends object>(params: {
  pluginId: string;
  artifactBasename: string;
}) => Promise<T>;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test loaders use caller-supplied module surface types.
type BundledPluginPublicSurfaceLoader = <T extends object>(params: {
  pluginId: string;
  artifactBasename: string;
}) => T;

export const loadBundledPluginPublicSurface: AsyncBundledPluginPublicSurfaceLoader = async (
  params,
) => {
  const artifactPath = resolveSourceArtifactPath(
    resolveExtensionDirByManifestId(params.pluginId),
    params.artifactBasename,
  );
  return await import(pathToFileURL(artifactPath).href);
};

export const loadBundledPluginPublicSurfaceSync: BundledPluginPublicSurfaceLoader = (_params) => {
  throw new Error("Synchronous bundled plugin public-surface loading is not available here");
};

export function resolveWorkspacePackagePublicModuleUrl(params: {
  packageName: string;
  artifactBasename: string;
}): string {
  const artifactPath = resolveSourceArtifactPath(
    resolveWorkspacePackageDir(params.packageName),
    params.artifactBasename,
  );
  return pathToFileURL(artifactPath).href;
}
