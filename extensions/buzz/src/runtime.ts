import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "../runtime-api.js";

const { setRuntime: setBuzzRuntime, getRuntime: getBuzzRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "buzz",
    errorMessage: "Buzz runtime not initialized",
  });

export { getBuzzRuntime, setBuzzRuntime };
