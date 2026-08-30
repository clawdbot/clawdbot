// Shares plugin runtime workspace state across module reloads.
import { PLUGIN_REGISTRY_STATE } from "./runtime-state-key.js";

type GlobalRegistryWorkspaceState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: {
    workspaceDir?: string | null;
  };
};

/** Reads the active plugin registry workspace directory from global runtime state. */
export function getActivePluginRegistryWorkspaceDirFromStateCore(): string | undefined {
  return (
    (globalThis as GlobalRegistryWorkspaceState)[PLUGIN_REGISTRY_STATE]?.workspaceDir ?? undefined
  );
}
