import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { ReefFederationState } from "./federation-state.js";
import type { ReefMessageFlow } from "./flow.js";
import type { ReefFriendManager } from "./friends.js";
import type { ReviewApprovalStore } from "./state.js";
import type { ReefTrustStore } from "./trust-store.js";

type ActiveReef = {
  flow: ReefMessageFlow;
  friends: ReefFriendManager;
  reviews: ReviewApprovalStore;
  federation: ReefFederationState;
  trust: ReefTrustStore;
};

const {
  setRuntime: setReefRuntime,
  tryGetRuntime: getOptionalReefRuntime,
  getRuntime: getReefRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "reef",
  errorMessage: "Reef runtime unavailable",
});

const activeReefStore = createPluginRuntimeStore<{
  value: ActiveReef;
  controller: AbortController;
  signal: AbortSignal;
}>({
  key: "plugin-runtime:reef:active",
  errorMessage: "Reef channel is not running",
});

export { getOptionalReefRuntime, getReefRuntime, setReefRuntime };

export function createReefRuntimeAuthority(parentSignal?: AbortSignal) {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  let registration: ReturnType<typeof activeReefStore.tryGetRuntime> = null;
  return {
    signal,
    activate(value: ActiveReef): void {
      signal.throwIfAborted();
      const predecessor = activeReefStore.tryGetRuntime();
      registration = { value, controller, signal };
      activeReefStore.setRuntime(registration);
      predecessor?.controller.abort();
    },
    release(): void {
      controller.abort();
      // A stopped generation must never clear its replacement, even across module instances.
      if (activeReefStore.tryGetRuntime() === registration) {
        activeReefStore.clearRuntime();
      }
    },
  };
}

export function getActiveReef(): ActiveReef {
  const registration = activeReefStore.getRuntime();
  if (registration.signal.aborted) {
    throw new Error("Reef channel is not running");
  }
  return registration.value;
}
