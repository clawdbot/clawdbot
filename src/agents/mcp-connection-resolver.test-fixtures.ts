import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRegistry } from "../plugins/registry.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";

export function createMcpProofPluginRegistry() {
  const pluginRegistry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });

  return {
    registry: pluginRegistry.registry,
    apiFor: (pluginId: string) => {
      const record = createPluginRecord({
        id: pluginId,
        source: `/plugins/${pluginId}/index.ts`,
      });
      pluginRegistry.registry.plugins.push(record);
      return pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
    },
  };
}
