// Telegram plugin module implements runtime behavior.
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { TelegramRuntime } from "./runtime.types.js";

const {
  setRuntime: setTelegramRuntime,
  getRuntime: getTelegramRuntime,
  tryGetRuntime: getOptionalTelegramRuntime,
} = createPluginRuntimeStore<TelegramRuntime>({
  pluginId: "telegram",
  errorMessage: "Telegram runtime not initialized",
});
export { getOptionalTelegramRuntime, getTelegramRuntime, setTelegramRuntime };
