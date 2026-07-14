import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { ReefMessageFlow } from "./flow.js";
import type { ReefFriendManager } from "./friends.js";
import type { ReviewApprovalStore } from "./state.js";

let runtime: PluginRuntime | undefined;
let active:
  | { flow: ReefMessageFlow; friends: ReefFriendManager; reviews: ReviewApprovalStore }
  | undefined;

export function setReefRuntime(value: PluginRuntime): void {
  runtime = value;
}
export function getReefRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Reef runtime unavailable");
  }
  return runtime;
}
export function setActiveReef(value: typeof active): void {
  active = value;
}
export function getActiveReef() {
  if (!active) {
    throw new Error("Reef channel is not running");
  }
  return active;
}
