// Shares plugin runtime workspace state across module reloads.
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { PLUGIN_REGISTRY_STATE } from "./runtime-state-key.js";

const PINNED_PLUGIN_REGISTRY_WORKSPACE_KEY = Symbol.for(
  "openclaw.pinnedPluginRegistryWorkspaceDir",
);

type GlobalRegistryWorkspaceState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: {
    workspaceDir?: string | null;
  };
};

const pinnedWorkspaceDirStorage = resolveGlobalSingleton<
  AsyncLocalStorage<{ workspaceDir: string | undefined }>
>(PINNED_PLUGIN_REGISTRY_WORKSPACE_KEY, () => new AsyncLocalStorage());

/** Reads the active plugin registry workspace directory from global runtime state,
 *  respecting any pinned workspace from the current async context. */
export function getActivePluginRegistryWorkspaceDirFromState(): string | undefined {
  const pinned = pinnedWorkspaceDirStorage.getStore();
  if (pinned) {
    return pinned.workspaceDir;
  }
  return (
    (globalThis as GlobalRegistryWorkspaceState)[PLUGIN_REGISTRY_STATE]?.workspaceDir ?? undefined
  );
}

/**
 * Pin the active plugin-registry workspace dir for the duration of `fn`.
 * While pinned, calls to `getActivePluginRegistryWorkspaceDirFromState()` return
 * the snapshot taken at pin time, ignoring concurrent mutations from other
 * agent turns or crons. This prevents per-row memo-busting in operations that
 * iterate over many rows (e.g. sessions.list).
 */
export function withPinnedActivePluginRegistryWorkspaceDir<T>(fn: () => T): T {
  if (pinnedWorkspaceDirStorage.getStore()) {
    // Already pinned in an outer scope — reuse it.
    return fn();
  }
  const workspaceDir =
    (globalThis as GlobalRegistryWorkspaceState)[PLUGIN_REGISTRY_STATE]?.workspaceDir ?? undefined;
  return pinnedWorkspaceDirStorage.run({ workspaceDir }, fn);
}
