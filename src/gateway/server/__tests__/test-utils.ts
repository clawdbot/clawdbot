// Gateway server test utilities build plugin-registry fixtures for nested server suites.
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../../plugins/registry.js";

/**
 * Shared plugin-registry fixtures for gateway server tests.
 */
export const createTestRegistry = (overrides: Partial<PluginRegistry> = {}): PluginRegistry => {
  const registry = createEmptyPluginRegistry();
  for (const key of Object.keys(overrides) as Array<keyof PluginRegistry>) {
    const value = overrides[key];
    if (value !== undefined) {
      Object.assign(registry, { [key]: value });
    }
  }
  return registry;
};
