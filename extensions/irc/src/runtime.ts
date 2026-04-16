import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-api.js";

const {
  setRuntime: setIrcRuntime,
  clearRuntime: clearStoredIrcRuntime,
  getRuntime: getIrcRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "irc",
  errorMessage: "IRC runtime not initialized",
});
export { getIrcRuntime, setIrcRuntime };
export function clearIrcRuntime() {
  clearStoredIrcRuntime();
}
