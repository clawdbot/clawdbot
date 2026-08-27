import {
  assertDirectPluginRegistrationReplacement,
  requireActivePluginRegistry,
  resolveDirectPluginRegistrationOwner,
} from "../plugins/runtime.js";
// Tracks detached task runtime state and spawned process handles.
import type {
  DetachedTaskLifecycleRuntime,
  DetachedTaskLifecycleRuntimeRegistration,
} from "./detached-task-runtime-contract.js";

const getRegistrations = () => requireActivePluginRegistry().detachedTaskRuntimes;

/** Registers the active detached task lifecycle runtime implementation. */
export function registerDetachedTaskLifecycleRuntime(
  requestedPluginId: string,
  runtime: DetachedTaskLifecycleRuntime,
): void {
  const registrations = getRegistrations();
  const pluginId = resolveDirectPluginRegistrationOwner(requestedPluginId) ?? requestedPluginId;
  if (registrations[0]) {
    assertDirectPluginRegistrationReplacement(registrations[0].pluginId, "detached task runtime");
  }
  registrations.splice(0, registrations.length, { pluginId, runtime });
}

export function getDetachedTaskLifecycleRuntimeRegistration():
  | DetachedTaskLifecycleRuntimeRegistration
  | undefined {
  const registration = getRegistrations()[0];
  if (!registration) {
    return undefined;
  }
  return {
    pluginId: registration.pluginId,
    runtime: registration.runtime,
  };
}

export function getRegisteredDetachedTaskLifecycleRuntime():
  | DetachedTaskLifecycleRuntime
  | undefined {
  return getRegistrations()[0]?.runtime;
}

export function clearDetachedTaskLifecycleRuntimeRegistration(): void {
  getRegistrations().length = 0;
}
