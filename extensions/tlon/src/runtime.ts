import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setTlonRuntime, getRuntime: getTlonRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Tlon runtime not initialized");
export { getTlonRuntime, setTlonRuntime };
