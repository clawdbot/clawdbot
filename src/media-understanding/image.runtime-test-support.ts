import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";

export function createImageRuntimeGenerationFixture(config: OpenClawConfig, workspaceDir?: string) {
  return {
    config,
    workspaceDir,
    metadataSnapshot: loadPluginMetadataSnapshot({ config, workspaceDir }),
    pluginRegistry: createEmptyPluginRegistry(),
  };
}
