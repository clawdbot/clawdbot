// Tracks detached task runtime state and spawned process handles.
import type {
  DetachedTaskLifecycleRuntime,
  DetachedTaskLifecycleRuntimeRegistration,
} from "./detached-task-runtime-contract.js";

export type { DetachedTaskLifecycleRuntime };

// Process-wide detached task runtime registration, owned by plugin activation.
let detachedTaskLifecycleRuntimeRegistration: DetachedTaskLifecycleRuntimeRegistration | undefined;

/** Registers the active detached task lifecycle runtime implementation. */
export function registerDetachedTaskLifecycleRuntime(
  pluginId: string,
  runtime: DetachedTaskLifecycleRuntime,
): void {
  detachedTaskLifecycleRuntimeRegistration = {
    pluginId,
    runtime,
  };
}

export function getDetachedTaskLifecycleRuntimeRegistration():
  | DetachedTaskLifecycleRuntimeRegistration
  | undefined {
  if (!detachedTaskLifecycleRuntimeRegistration) {
    return undefined;
  }
  return {
    pluginId: detachedTaskLifecycleRuntimeRegistration.pluginId,
    runtime: detachedTaskLifecycleRuntimeRegistration.runtime,
  };
}

export function getRegisteredDetachedTaskLifecycleRuntime():
  | DetachedTaskLifecycleRuntime
  | undefined {
  return detachedTaskLifecycleRuntimeRegistration?.runtime;
}

export function restoreDetachedTaskLifecycleRuntimeRegistration(
  registration: DetachedTaskLifecycleRuntimeRegistration | undefined,
): void {
  detachedTaskLifecycleRuntimeRegistration = registration
    ? {
        pluginId: registration.pluginId,
        runtime: registration.runtime,
      }
    : undefined;
}

export function clearDetachedTaskLifecycleRuntimeRegistration(): void {
  detachedTaskLifecycleRuntimeRegistration = undefined;
}
