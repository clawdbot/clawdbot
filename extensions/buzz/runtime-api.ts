import { buzzQaCliRegistration } from "./src/qa/cli.js";

export type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
export type { ChannelPlugin, PluginRuntime } from "openclaw/plugin-sdk/core";

export const qaRunnerCliRegistrations = [buzzQaCliRegistration];
