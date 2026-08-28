import type { PluginWidgetPresenterRegistration, PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

function hasMatchingLoadedOwner(
  registration: PluginWidgetPresenterRegistration,
  targetRegistry: PluginRegistry,
  runtimeRegistry: PluginRegistry,
): boolean {
  const target = targetRegistry.plugins.find((plugin) => plugin.id === registration.pluginId);
  const runtime = runtimeRegistry.plugins.find((plugin) => plugin.id === registration.pluginId);
  return (
    target?.status === "loaded" &&
    runtime?.status === "loaded" &&
    target.source === runtime.source &&
    registration.source === runtime.source
  );
}

/** Copies full-only presenters into a matching discovery registry without rerunning plugin code. */
export function adoptRuntimeWidgetPresenterRegistrations(
  targetRegistry: PluginRegistry,
  runtimeRegistry: PluginRegistry,
): PluginRegistry {
  const presenters = [...targetRegistry.widgetPresenters];
  let changed = false;
  for (const registration of runtimeRegistry.widgetPresenters) {
    if (!hasMatchingLoadedOwner(registration, targetRegistry, runtimeRegistry)) {
      continue;
    }
    const conflicts = presenters.some((candidate) =>
      registration.presenter.target === "current_channel"
        ? candidate.pluginId === registration.pluginId &&
          candidate.presenter.target === registration.presenter.target
        : candidate.presenter.target === registration.presenter.target,
    );
    if (!conflicts) {
      presenters.push(registration);
      changed = true;
    }
  }
  return changed ? { ...targetRegistry, widgetPresenters: presenters } : targetRegistry;
}

/** Returns presenter registrations from the exact request registry when available. */
export function resolveWidgetPresenters(): readonly PluginWidgetPresenterRegistration[] {
  const registry =
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry() ?? undefined;
  return registry?.widgetPresenters ?? [];
}
