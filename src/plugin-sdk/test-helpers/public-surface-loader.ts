// Public surface loader test helpers import SDK subpaths for export-contract assertions.
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

type AsyncBundledPluginPublicSurfaceLoader = <T extends object>(params: {
  pluginId: string;
  artifactBasename: string;
}) => Promise<T>;

export const loadBundledPluginPublicSurface: AsyncBundledPluginPublicSurfaceLoader = async (
  params,
) => {
  const artifactPath = resolveSourceArtifactPath(
    resolveExtensionDirByManifestId(params.pluginId),
    params.artifactBasename,
  );
  return await import(pathToFileURL(artifactPath).href);
};
