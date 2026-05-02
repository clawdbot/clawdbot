import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEnabledBundledManifestContractPlugins } from "./bundled-manifest-contract-plugins.js";
import { loadBundledWebContentExtractorEntriesFromDir } from "./web-content-extractor-public-artifacts.js";
import type { PluginWebContentExtractorEntry } from "./web-content-extractor-types.js";

function compareExtractors(
  left: PluginWebContentExtractorEntry,
  right: PluginWebContentExtractorEntry,
): number {
  const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id) || left.pluginId.localeCompare(right.pluginId);
}

export function resolvePluginWebContentExtractors(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}): PluginWebContentExtractorEntry[] {
  const extractors: PluginWebContentExtractorEntry[] = [];
  for (const plugin of resolveEnabledBundledManifestContractPlugins({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
    onlyPluginIds: params?.onlyPluginIds,
    contract: "webContentExtractors",
    compatMode: {
      allowlist: true,
      enablement: "always",
      vitest: true,
    },
  })) {
    const loaded = loadBundledWebContentExtractorEntriesFromDir({
      dirName: plugin.id,
      pluginId: plugin.id,
    });
    if (loaded) {
      extractors.push(...loaded);
    }
  }
  return extractors.toSorted(compareExtractors);
}
