import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-api.js";

const { setRuntime: setMatrixRuntime, getRuntime: getMatrixRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Matrix runtime not initialized");

export { getMatrixRuntime, setMatrixRuntime };
