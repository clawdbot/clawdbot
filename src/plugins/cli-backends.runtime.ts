// Runtime bridge for plugin-provided CLI backends.
import { getActiveRuntimePluginRegistry } from "./active-runtime-registry.js";
import type { CliBackendPlugin } from "./cli-backend.types.js";

/** Runtime CLI backend registration with owning plugin id. */
export type PluginCliBackendEntry = CliBackendPlugin & {
  pluginId: string;
};

/** Resolves CLI backends from the active runtime plugin registry. */
export function resolveRuntimeCliBackends(): PluginCliBackendEntry[] {
  return (getActiveRuntimePluginRegistry()?.cliBackends ?? []).map((entry) =>
    Object.assign({}, entry.backend, { pluginId: entry.pluginId }),
  );
}
