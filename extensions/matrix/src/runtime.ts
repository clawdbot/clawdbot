import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
// Matrix plugin module implements runtime behavior.
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const {
  setRuntime: setMatrixRuntime,
  getRuntime: getMatrixRuntime,
  tryGetRuntime: getOptionalMatrixRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "matrix",
  errorMessage: "Matrix runtime not initialized",
});

export { getMatrixRuntime, getOptionalMatrixRuntime, setMatrixRuntime };
