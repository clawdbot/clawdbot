import { getActiveRuntimePluginRegistry } from "./active-runtime-registry.js";
import type { CliBackendPlugin } from "./cli-backend.types.js";

export type PluginCliBackendEntry = CliBackendPlugin & {
  pluginId: string;
};

export function resolveRuntimeCliBackends(): PluginCliBackendEntry[] {
  return (getActiveRuntimePluginRegistry()?.cliBackends ?? []).map((entry) =>
    Object.assign({}, entry.backend, { pluginId: entry.pluginId }),
  );
}
