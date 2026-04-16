import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

type SlackChannelRuntime = {
  handleSlackAction?: typeof import("./action-runtime.js").handleSlackAction;
};

export type SlackRuntime = PluginRuntime & {
  channel: PluginRuntime["channel"] & {
    slack?: SlackChannelRuntime;
  };
};

const {
  setRuntime: setSlackRuntime,
  clearRuntime: clearSlackRuntime,
  tryGetRuntime: getOptionalSlackRuntime,
  getRuntime: getSlackRuntime,
} = createPluginRuntimeStore<SlackRuntime>({
  pluginId: "slack",
  errorMessage: "Slack runtime not initialized",
});
export { clearSlackRuntime, getOptionalSlackRuntime, getSlackRuntime, setSlackRuntime };
