import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { ReefMessageFlow } from "./flow.js";
import type { ReefFriendManager } from "./friends.js";
import type { ReviewApprovalStore } from "./state.js";

type ActiveReef =
  | { flow: ReefMessageFlow; friends: ReefFriendManager; reviews: ReviewApprovalStore }
  | undefined;

const {
  setRuntime: setReefRuntime,
  tryGetRuntime: getOptionalReefRuntime,
  getRuntime: getReefRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "reef",
  errorMessage: "Reef runtime unavailable",
});

// Keep the live channel handle in a second named slot: duplicate bundled-plugin
// module instances must observe the same running Reef instance for outbound sends.
const activeReefStore = createPluginRuntimeStore<Exclude<ActiveReef, undefined>>({
  key: "plugin-runtime:reef:active",
  errorMessage: "Reef channel is not running",
});

export { getOptionalReefRuntime, getReefRuntime, setReefRuntime };

export function setActiveReef(value: ActiveReef): void {
  if (value) {
    activeReefStore.setRuntime(value);
  } else {
    activeReefStore.clearRuntime();
  }
}

export const getActiveReef = activeReefStore.getRuntime;
