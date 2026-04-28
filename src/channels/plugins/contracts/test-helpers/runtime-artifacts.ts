import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBundledChannelWorkspacePath } from "../../../../plugins/bundled-channel-runtime.js";
import {
  resolvePluginRuntimeModulePath,
  resolvePluginRuntimeRecord,
} from "../../../../plugins/runtime/runtime-plugin-boundary.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

function resolveBundledChannelWorkspaceArtifactPath(
  pluginId: string,
  entryBaseName: string,
): string | null {
  const normalizedEntryBaseName = entryBaseName.replace(/\.(?:[cm]?js|ts)$/u, "");
  const pluginRoot = resolveBundledChannelWorkspacePath({
    rootDir: REPO_ROOT,
    pluginId,
  });
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

export function resolveBundledChannelContractArtifactUrl(
  pluginId: string,
  entryBaseName: string,
): string {
  const normalizedEntryBaseName = entryBaseName.replace(/\.(?:[cm]?js|ts)$/u, "");
  const record = resolvePluginRuntimeRecord(pluginId, () => {
    throw new Error(`missing bundled channel plugin '${pluginId}'`);
  });
  if (!record) {
    throw new Error(`missing bundled channel plugin '${pluginId}'`);
  }
  const modulePath =
    resolvePluginRuntimeModulePath(record, normalizedEntryBaseName) ??
    resolveBundledChannelWorkspaceArtifactPath(pluginId, entryBaseName);
  if (!modulePath) {
    throw new Error(`missing ${entryBaseName} for bundled channel plugin '${pluginId}'`);
  }
  return pathToFileURL(modulePath).href;
}

export async function importBundledChannelContractArtifact<T extends object>(
  pluginId: string,
  entryBaseName: string,
): Promise<T> {
  return (await import(resolveBundledChannelContractArtifactUrl(pluginId, entryBaseName))) as T;
}
