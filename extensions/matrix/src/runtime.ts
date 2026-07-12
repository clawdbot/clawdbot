// Matrix plugin module implements runtime behavior.
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-api.js";

const {
  setRuntime: setMatrixRuntime,
  clearRuntime: clearMatrixRuntime,
  getRuntime: getMatrixRuntime,
  tryGetRuntime: getOptionalMatrixRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "matrix",
  errorMessage: "Matrix runtime not initialized",
});

export { clearMatrixRuntime, getMatrixRuntime, getOptionalMatrixRuntime, setMatrixRuntime };
