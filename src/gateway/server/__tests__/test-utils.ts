import { createEmptyPluginRegistry, type PluginRegistry } from "../../../plugins/registry.js";

/**
 * Shared plugin-registry fixtures for gateway server tests.
 */
export const createTestRegistry = (overrides: Partial<PluginRegistry> = {}): PluginRegistry => {
  const merged = { ...createEmptyPluginRegistry(), ...overrides };
  return {
    ...merged,
    gatewayHandlers: merged.gatewayHandlers ?? {},
    httpRoutes: merged.httpRoutes ?? [],
  };
};
