// Runtime bridge for web content extractors supplied by plugins.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEnabledBundledManifestContractPlugins } from "./bundled-manifest-contract-plugins.js";
import { sortPluginEntriesForAutoDetect } from "./plugin-entry-order.js";
import { loadBundledWebContentExtractorEntriesFromDir } from "./web-content-extractor-public-artifacts.js";
import type { PluginWebContentExtractorEntry } from "./web-content-extractor-types.js";

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
  })) {
    const loaded = loadBundledWebContentExtractorEntriesFromDir({
      dirName: plugin.id,
      pluginId: plugin.id,
    });
    if (loaded) {
      extractors.push(...loaded);
    }
  }
  return sortPluginEntriesForAutoDetect(extractors);
}
