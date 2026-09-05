/**
 * Bundled channel runtime artifact resolver.
 *
 * Resolves generated contract artifacts through runtime records with local workspace fallback.
 */
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { vi } from "vitest";
import { listBundledChannelPluginMetadata } from "../../../../plugins/bundled-channel-runtime.js";
import { resolvePluginRootPublicSurfacePath } from "../../../../plugins/public-surface-runtime.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../../../test-utils/bundled-plugin-public-surface.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/** Installs plugin-owned transport mocks before loading a public source artifact. */
export async function importBundledChannelContractSourceArtifact<T extends object>(
  pluginId: string,
  artifactBasename: string,
  mockFactories: Record<string, () => Record<string, unknown>>,
): Promise<T> {
  const moduleId = resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId,
    artifactBasename,
  });
  const requirePlugin = createRequire(new URL(moduleId, import.meta.url));
  // Lazy transport imports still need these mocks after this loader returns;
  // the test runner clears the mock registry between files.
  for (const [dependency, factory] of Object.entries(mockFactories)) {
    vi.doMock(requirePlugin.resolve(dependency), factory);
  }
  return (await import(moduleId)) as T;
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
  const modulePath = resolvePluginRootPublicSurfacePath({
    pluginRoot: metadata.rootDir,
    pluginId,
    entrySource: metadata.source.built,
    artifactBasename: `${normalizedEntryBaseName}.js`,
  });
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
