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
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    gatewayHandlers: merged.gatewayHandlers ?? {},
    httpHandlers: merged.httpHandlers ?? [],
    httpRoutes: merged.httpRoutes ?? [],
  };
};
