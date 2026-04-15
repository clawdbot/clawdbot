import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setQQBotRuntime, getRuntime: getQQBotRuntime } =
  createPluginRuntimeStore<PluginRuntime>("QQBot runtime not initialized");
export { getQQBotRuntime, setQQBotRuntime };
