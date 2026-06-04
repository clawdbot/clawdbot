// Shares plugin runtime workspace state across module reloads.
const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type GlobalRegistryWorkspaceState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: {
    workspaceDir?: string | null;
  };
};

/** Reads the active plugin registry workspace directory from global runtime state. */
export function getActivePluginRegistryWorkspaceDirFromState(): string | undefined {
  return (
    (globalThis as GlobalRegistryWorkspaceState)[PLUGIN_REGISTRY_STATE]?.workspaceDir ?? undefined
  );
}
