// Signal plugin module implements runtime behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setSignalRuntime, tryGetRuntime: getOptionalSignalRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "signal",
    errorMessage: "Signal runtime not initialized",
  });
export { getOptionalSignalRuntime, setSignalRuntime };
