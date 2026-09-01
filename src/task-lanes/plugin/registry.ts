/** Plugin registration of task-lane providers. */

import { createTaskLaneRegistry, registerTaskLaneProvider } from "../registry.js";
import type { TaskLaneProvider } from "../types.js";

/** Per-plugin task-lane provider registration. */
export type PluginTaskLaneProviderRegistration = {
  pluginId: string;
  pluginName?: string;
  provider: TaskLaneProvider;
};

/** Aggregated plugin-owned task-lane providers. */
export type PluginTaskLaneRegistry = {
  providers: Map<string, PluginTaskLaneProviderRegistration>;
};

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/;

export function createPluginTaskLaneRegistry(): PluginTaskLaneRegistry {
  return { providers: new Map() };
}

export function registerPluginTaskLaneProvider(
  registry: PluginTaskLaneRegistry,
  registration: PluginTaskLaneProviderRegistration,
): void {
  const id = registration.provider.id;
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(`invalid task lane provider id: ${id}`);
  }
  if (registry.providers.has(id)) {
    throw new Error(`task lane provider already registered: ${id}`);
  }
  registry.providers.set(id, registration);
}

/**
 * Builds the runtime task-lane registry from a plugin-owned registry. The
 * runtime registry accepts a per-registration `pluginId` so plugin churn is
 * traceable from lane data back to its source.
 */
export function buildRuntimeTaskLaneRegistry(
  pluginRegistry: PluginTaskLaneRegistry,
): ReturnType<typeof createTaskLaneRegistry> {
  const runtime = createTaskLaneRegistry();
  for (const { provider } of pluginRegistry.providers.values()) {
    registerTaskLaneProvider(runtime, provider);
  }
  return runtime;
}
