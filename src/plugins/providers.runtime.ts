import { nativePluginBindings } from "./loader-runtime-load.js";
export const { isPluginProvidersLoadInFlight, acquirePluginProvidersCore } =
  nativePluginBindings.providerRegistry;
export type { PluginProvidersHandle } from "./providers.runtime-core.js";
