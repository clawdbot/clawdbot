import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { ReefMessageFlow } from "./flow.js";
import type { ReefFriendManager } from "./friends.js";
import type { ReviewApprovalStore } from "./state.js";

type ActiveReef = {
  flow: ReefMessageFlow;
  friends: ReefFriendManager;
  reviews: ReviewApprovalStore;
};

const {
  setRuntime: setReefRuntime,
  tryGetRuntime: getOptionalReefRuntime,
  getRuntime: getReefRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "reef",
  errorMessage: "Reef runtime unavailable",
});

const activeReefStore = createPluginRuntimeStore<{ value: ActiveReef }>({
  key: "plugin-runtime:reef:active",
  errorMessage: "Reef channel is not running",
});

export { getOptionalReefRuntime, getReefRuntime, setReefRuntime };

export function setActiveReef(value: ActiveReef): () => void {
  const registration = { value };
  activeReefStore.setRuntime(registration);
  return () => {
    // A stopped generation must never clear its replacement, even across module instances.
    if (activeReefStore.tryGetRuntime() === registration) {
      activeReefStore.clearRuntime();
    }
  };
}

export function getActiveReef(): ActiveReef {
  return activeReefStore.getRuntime().value;
}
