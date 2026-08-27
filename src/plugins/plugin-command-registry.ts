/** Exact registry projection helpers for plugin command runtimes. */
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRegistryState } from "./runtime-state.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

export function resolveSelectedPluginCommandRegistry(): PluginRegistry | null {
  const state = getPluginRegistryState();
  return (
    state?.registrationContext?.registry ??
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ??
    state?.activeRegistry ??
    null
  );
}

export function listRegisteredPluginCommands(registry: PluginRegistry) {
  return registry.commands.map((entry) => ({
    ...entry.command,
    pluginId: entry.pluginId,
    pluginName: entry.pluginName,
    pluginRoot: entry.rootDir,
    trustedOwnerStatusExposure: entry.trustedOwnerStatusExposure,
  }));
}
