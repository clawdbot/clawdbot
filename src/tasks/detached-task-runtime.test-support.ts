import { requireActivePluginRegistry } from "../plugins/runtime.js";
import type { DetachedTaskLifecycleRuntime } from "./detached-task-runtime-contract.js";

export function setDetachedTaskLifecycleRuntime(
  runtime: DetachedTaskLifecycleRuntime,
  pluginId = "__test__",
): void {
  const registrations = requireActivePluginRegistry().detachedTaskRuntimes;
  registrations.splice(0, registrations.length, { pluginId, runtime });
}

export function resetDetachedTaskLifecycleRuntimeForTests(): void {
  requireActivePluginRegistry().detachedTaskRuntimes.length = 0;
}
