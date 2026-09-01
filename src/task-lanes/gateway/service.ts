/** Gateway-side service that owns the runtime task-lane registry. */

import { buildRuntimeTaskLaneRegistry, type PluginTaskLaneRegistry } from "../plugin/registry.js";
import {
  createTaskLaneRegistry,
  loadTaskLaneSnapshot,
  registerTaskLaneProvider,
  type TaskLaneRegistry,
} from "../registry.js";
import type { TaskLaneProvider, TaskLaneSnapshot } from "../types.js";

export type TaskLaneGatewayService = {
  addProvider(provider: TaskLaneProvider): void;
  rebuildFromPlugins(pluginRegistry: PluginTaskLaneRegistry): void;
  snapshot(options?: {
    providerId?: string;
    limit?: number;
    offset?: number;
  }): Promise<TaskLaneSnapshot>;
  registry(): TaskLaneRegistry;
};

export function createTaskLaneGatewayService(): TaskLaneGatewayService {
  let registry: TaskLaneRegistry = createTaskLaneRegistry();
  return {
    addProvider(provider) {
      registerTaskLaneProvider(registry, provider);
    },
    rebuildFromPlugins(pluginRegistry) {
      registry = buildRuntimeTaskLaneRegistry(pluginRegistry);
    },
    snapshot(options) {
      return loadTaskLaneSnapshot(registry, options);
    },
    registry() {
      return registry;
    },
  };
}
