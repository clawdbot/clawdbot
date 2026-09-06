import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";

export function createRuntimeTestRegistry(runtime: PluginRuntime) {
  const pluginRegistry = createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime,
    activateGlobalSideEffects: false,
  });
  const createApi: typeof pluginRegistry.createApi = (record, params) => {
    pluginRegistry.registry.plugins.push(record);
    return pluginRegistry.createApi(record, params);
  };
  return { ...pluginRegistry, createApi };
}
