/** Gateway-side service that owns the runtime task-lane registry. */

import {
  createTaskLaneRegistry,
  loadTaskLaneSnapshot,
  registerTaskLaneProvider,
  type TaskLaneRegistry,
} from "../registry.js";
import type { TaskLaneProvider, TaskLaneSnapshot } from "../types.js";

export type TaskLaneGatewayService = {
  addProvider(provider: TaskLaneProvider): void;
  snapshot(options?: {
    providerId?: string;
    limit?: number;
    offset?: number;
  }): Promise<TaskLaneSnapshot>;
  hasProviders(): boolean;
  registry(): TaskLaneRegistry;
};

export function createTaskLaneGatewayService(): TaskLaneGatewayService {
  const registry: TaskLaneRegistry = createTaskLaneRegistry();
  return {
    addProvider(provider) {
      registerTaskLaneProvider(registry, provider);
    },
    snapshot(options) {
      return loadTaskLaneSnapshot(registry, options);
    },
    hasProviders() {
      return registry.providers.size > 0;
    },
    registry() {
      return registry;
    },
  };
}
