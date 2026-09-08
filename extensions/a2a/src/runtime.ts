import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-api.js";

const { setRuntime: setA2aChannelRuntime, getRuntime: getA2aChannelRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "a2a",
    errorMessage: "A2A channel runtime not initialized",
  });

export { getA2aChannelRuntime, setA2aChannelRuntime };
