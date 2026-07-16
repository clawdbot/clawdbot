export type { ChannelPlugin, OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/core";
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
export type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk/core";
export type { ResolvedQQBotAccount, QQBotAccountConfig } from "./src/types.js";
export { getQQBotRuntime, setQQBotRuntime } from "./src/runtime.js";
