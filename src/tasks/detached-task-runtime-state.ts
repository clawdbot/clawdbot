import { requireActivePluginRegistry } from "../plugins/runtime.js";
import type { DetachedTaskLifecycleRuntime } from "./detached-task-runtime-contract.js";

export function getRegisteredDetachedTaskLifecycleRuntime():
  | DetachedTaskLifecycleRuntime
  | undefined {
  return requireActivePluginRegistry().detachedTaskRuntimes[0]?.runtime;
}
