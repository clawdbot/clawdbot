import type { PluginRegistry } from "../../../plugins/registry.js";

export const createTestRegistry = (overrides: Partial<PluginRegistry> = {}): PluginRegistry => {
  const base: PluginRegistry = {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    cliRegistrars: [],
    services: [],
    diagnostics: [],
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    gatewayHandlers: merged.gatewayHandlers ?? {},
    httpHandlers: merged.httpHandlers ?? [],
  };
};
