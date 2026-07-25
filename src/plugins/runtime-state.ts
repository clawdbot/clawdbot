import { PLUGIN_REGISTRY_STATE } from "./runtime-state-key.js";
// Stores plugin runtime registry state for the current process lifecycle.
import { getActivePluginRegistryWorkspaceDirFromState as getPinnedWorkspaceDirFromState } from "./runtime-workspace-state.js";

export { PLUGIN_REGISTRY_STATE };

type PluginRegistry = import("./registry-types.js").PluginRegistry;

type RuntimeTrackedPluginRegistry = PluginRegistry;

export type RegistrySurfaceState = {
  registry: RuntimeTrackedPluginRegistry | null;
  pinned: boolean;
  version: number;
};

export type RegistryState = {
  activeRegistry: RuntimeTrackedPluginRegistry | null;
  activeVersion: number;
  httpRoute: RegistrySurfaceState;
  channel: RegistrySurfaceState;
  sessionExtension: RegistrySurfaceState;
  agentEventBridgeUnsubscribe?: (() => void) | undefined;
  key: string | null;
  workspaceDir: string | null;
  runtimeSubagentMode: "default" | "explicit" | "gateway-bindable";
  importedPluginIds: Set<string>;
};

type GlobalRegistryState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: RegistryState;
};

export function getPluginRegistryState(): RegistryState | undefined {
  return (globalThis as GlobalRegistryState)[PLUGIN_REGISTRY_STATE];
}
export function getActivePluginRegistryWorkspaceDirFromState(): string | undefined {
  return getPinnedWorkspaceDirFromState();
}
