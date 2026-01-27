import type { PluginRegistry } from "./registry.js";

const createEmptyRegistry = (): PluginRegistry => ({
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
});

const REGISTRY_STATE = Symbol.for("moltbot.pluginRegistryState");

type RegistryState = {
  registry: PluginRegistry | null;
  key: string | null;
};

const state: RegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [REGISTRY_STATE]?: RegistryState;
  };
  if (!globalState[REGISTRY_STATE]) {
    globalState[REGISTRY_STATE] = {
      registry: createEmptyRegistry(),
      key: null,
    };
  }
  return globalState[REGISTRY_STATE] as RegistryState;
})();

export function setActivePluginRegistry(registry: PluginRegistry, cacheKey?: string) {
  state.registry = registry;
  state.key = cacheKey ?? null;
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return state.registry;
}

export function requireActivePluginRegistry(): PluginRegistry {
  if (!state.registry) {
    state.registry = createEmptyRegistry();
  }
  return state.registry;
}

export function getActivePluginRegistryKey(): string | null {
  return state.key;
}
