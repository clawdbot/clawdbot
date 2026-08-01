import type { InternalHookHandler } from "../hooks/internal-hook-types.js";
import {
  collectLivePluginRegistries,
  getPluginRegistrationContext,
  requireActivePluginRegistry,
} from "./runtime.js";

function listLiveRegistrations() {
  const registrations = [] as ReturnType<typeof requireActivePluginRegistry>["legacyInternalHooks"];
  const seenPluginIds = new Set<string>();
  for (const registry of collectLivePluginRegistries()) {
    // Ownership is capability-specific: hookless scoped/setup registries must not shadow
    // a pinned runtime that actually registered the plugin's legacy hooks.
    registrations.push(
      ...registry.legacyInternalHooks.filter((entry) => !seenPluginIds.has(entry.pluginId)),
    );
    registry.legacyInternalHooks.forEach((entry) => seenPluginIds.add(entry.pluginId));
  }
  return registrations;
}

export function listLegacyPluginInternalHooks(event: string): InternalHookHandler[] {
  return listLiveRegistrations()
    .filter((registration) => registration.event === event)
    .map((registration) => registration.handler);
}

export function listLegacyPluginInternalHookEventKeys(): string[] {
  return [...new Set(listLiveRegistrations().map((registration) => registration.event))];
}

export function clearLegacyPluginInternalHooks(): void {
  const context = getPluginRegistrationContext();
  const live = context ? [context.registry] : collectLivePluginRegistries();
  for (const registry of live.length > 0 ? live : [requireActivePluginRegistry()]) {
    registry.legacyInternalHooks.length = 0;
  }
}
