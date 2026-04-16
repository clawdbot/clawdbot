import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setSynologyRuntime, getRuntime: getSynologyRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "synology-chat",
    errorMessage: "Synology Chat runtime not initialized - plugin not registered",
  });
export { getSynologyRuntime, setSynologyRuntime };
