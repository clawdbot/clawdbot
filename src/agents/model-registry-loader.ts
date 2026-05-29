import type { OpenClawConfig } from "../config/types.openclaw.js";
import { discoverAuthStorage, discoverModels } from "./agent-model-discovery.js";
import { resolveDefaultAgentDir } from "./agent-scope.js";
import { resolveModelPluginMetadataSnapshot } from "./model-discovery-context.js";
import type { ModelRegistry } from "./sessions/index.js";

export type LoadAgentModelRegistryOptions = {
  providerFilter?: string;
  normalizeModels?: boolean;
  readOnly?: boolean;
  skipCredentials?: boolean;
  workspaceDir?: string;
};

export function loadAgentModelRegistry(
  config: OpenClawConfig,
  options: LoadAgentModelRegistryOptions = {},
): { agentDir: string; registry: ModelRegistry } {
  const agentDir = resolveDefaultAgentDir(config);
  const authStorage = discoverAuthStorage(agentDir, {
    readOnly: options.readOnly ?? true,
    skipCredentials: options.skipCredentials,
    config,
    workspaceDir: options.workspaceDir,
  });
  const pluginMetadataSnapshot = resolveModelPluginMetadataSnapshot({
    config,
    workspaceDir: options.workspaceDir,
  });
  const registry = discoverModels(authStorage, agentDir, {
    config,
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    providerFilter: options.providerFilter,
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
    normalizeModels: options.normalizeModels,
  });
  return { agentDir, registry };
}
