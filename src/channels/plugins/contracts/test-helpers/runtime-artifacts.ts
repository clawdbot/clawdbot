/**
 * Bundled channel runtime artifact resolver.
 *
 * Resolves generated contract artifacts through runtime records with local workspace fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listBundledChannelPluginMetadata } from "../../../../plugins/bundled-channel-runtime.js";
import { resolvePluginRuntimeModulePath } from "../../../../plugins/runtime/runtime-plugin-boundary.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../../../test-utils/bundled-plugin-public-surface.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/** Loads a public source artifact when a host contract must mock its transport dependency. */
export async function importBundledChannelContractSourceArtifact<T extends object>(
  pluginId: string,
  artifactBasename: string,
): Promise<T> {
  const moduleId = resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId,
    artifactBasename,
  });
  return (await import(moduleId)) as T;
}

function resolveBundledChannelWorkspaceArtifactPath(
  pluginId: string,
  entryBaseName: string,
): string | null {
  const normalizedEntryBaseName = entryBaseName.replace(/\.(?:[cm]?js|ts)$/u, "");
  const pluginRoot = listBundledChannelPluginMetadata({
    rootDir: REPO_ROOT,
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  }).find((metadata) => metadata.manifest.id === pluginId)?.rootDir;
  if (!pluginRoot) {
    return null;
  }
  for (const extension of ["js", "ts"]) {
    const candidate = path.join(pluginRoot, `${normalizedEntryBaseName}.${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveBundledChannelContractArtifactUrl(pluginId: string, entryBaseName: string): string {
  const normalizedEntryBaseName = entryBaseName.replace(/\.(?:[cm]?js|ts)$/u, "");
  const metadata = listBundledChannelPluginMetadata({
    rootDir: REPO_ROOT,
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  }).find((entry) => entry.manifest.id === pluginId);
  if (!metadata) {
    throw new Error(`missing bundled channel plugin '${pluginId}'`);
  }
  const modulePath =
    resolvePluginRuntimeModulePath(
      { rootDir: metadata.rootDir, source: metadata.source.built },
      normalizedEntryBaseName,
    ) ?? resolveBundledChannelWorkspaceArtifactPath(pluginId, entryBaseName);
  if (!modulePath) {
    throw new Error(`missing ${entryBaseName} for bundled channel plugin '${pluginId}'`);
  }
  return pathToFileURL(modulePath).href;
}

/** Imports a generated bundled channel artifact through the contract boundary. */
export async function importBundledChannelContractArtifact<T extends object>(
  pluginId: string,
  entryBaseName: string,
): Promise<T> {
  return (await import(resolveBundledChannelContractArtifactUrl(pluginId, entryBaseName))) as T;
}
