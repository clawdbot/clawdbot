import { PLUGIN_REGISTRY_STATE } from "./runtime-state-key.js";
// Stores plugin runtime registry state for the current process lifecycle.
import { getActivePluginRegistryWorkspaceDirFromState as getWorkspaceDirFromState } from "./runtime-workspace-state.js";

export { PLUGIN_REGISTRY_STATE };

type PluginRegistry = import("./registry-types.js").PluginRegistry;

export type RegistryState = {
  activeRegistry: PluginRegistry | null;
  activeVersion: number;
  agentEventBridgeUnsubscribe?: (() => void) | undefined;
  key: string | null;
  workspaceDir: string | null;
  runtimeSubagentMode: "default" | "explicit" | "gateway-bindable";
  importedPluginIds: Set<string>;
  registrationContext?: { registry: PluginRegistry; pluginId: string };
  commandRegistryClearTail?: Promise<void>;
  commandRegistryClearRegistries?: Map<PluginRegistry, number>;
};

type GlobalRegistryState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: RegistryState;
};

export function getPluginRegistryState(): RegistryState | undefined {
  return (globalThis as GlobalRegistryState)[PLUGIN_REGISTRY_STATE];
}
export function getActivePluginRegistryWorkspaceDirFromState(): string | undefined {
  return getWorkspaceDirFromState();
}
