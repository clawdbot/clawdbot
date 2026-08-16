import type { PluginRegistry } from "./registry-types.js";
import type { PluginRuntime } from "./runtime/types.js";

const PLUGIN_REGISTRY_RUNTIME = Symbol.for("openclaw.pluginRegistryRuntime");

type RuntimeBoundPluginRegistry = PluginRegistry & {
  [PLUGIN_REGISTRY_RUNTIME]?: PluginRuntime;
};

export function bindPluginRegistryRuntime(registry: PluginRegistry, runtime: PluginRuntime): void {
  Object.defineProperty(registry, PLUGIN_REGISTRY_RUNTIME, {
    configurable: false,
    enumerable: false,
    value: runtime,
    writable: false,
  });
}

export function getPluginRegistryRuntime(registry: PluginRegistry): PluginRuntime | undefined {
  return (registry as RuntimeBoundPluginRegistry)[PLUGIN_REGISTRY_RUNTIME];
}
