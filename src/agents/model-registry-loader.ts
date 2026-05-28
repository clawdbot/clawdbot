import type { OpenClawConfig } from "../config/types.openclaw.js";
import { discoverAuthStorage, discoverModels } from "./agent-model-discovery.js";
import { resolveDefaultAgentDir } from "./agent-scope.js";
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
  const registry = discoverModels(authStorage, agentDir, {
    providerFilter: options.providerFilter,
    normalizeModels: options.normalizeModels,
  });
  return { agentDir, registry };
}
