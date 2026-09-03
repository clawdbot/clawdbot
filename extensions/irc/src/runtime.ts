// Irc plugin module implements runtime behavior.
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setIrcRuntime, getRuntime: getIrcRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "irc",
    errorMessage: "IRC runtime not initialized",
  });
export { getIrcRuntime, setIrcRuntime };
