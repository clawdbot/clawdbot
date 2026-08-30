// Discord plugin module implements runtime behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { initializeDiscordProviderEndpointFromEnv } from "./provider-endpoint.js";

const {
  setRuntime: setDiscordRuntimeStore,
  tryGetRuntime: getOptionalDiscordRuntime,
  getRuntime: getDiscordRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "discord",
  errorMessage: "Discord runtime not initialized",
});

function setDiscordRuntime(runtime: PluginRuntime): void {
  initializeDiscordProviderEndpointFromEnv();
  setDiscordRuntimeStore(runtime);
}

export { getDiscordRuntime, getOptionalDiscordRuntime, setDiscordRuntime };
