import type { InternalHookHandler } from "../hooks/internal-hook-types.js";
import {
  collectLivePluginRegistries,
  getPluginRegistrationContext,
  requireActivePluginRegistry,
} from "./runtime.js";

export type LegacyPluginInternalHookRegistration = {
  event: string;
  handler: InternalHookHandler;
};

export type LegacyPluginInternalHookState = Map<string, LegacyPluginInternalHookRegistration[]>;

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

export function replaceLegacyPluginInternalHook(
  name: string,
  nextRegistrations: readonly LegacyPluginInternalHookRegistration[],
): LegacyPluginInternalHookRegistration[] {
  const registry = requireActivePluginRegistry();
  const previous = registry.legacyInternalHooks
    .filter((entry) => entry.name === name)
    .map(({ event, handler }) => ({ event, handler }));
  registry.legacyInternalHooks = registry.legacyInternalHooks.filter(
    (entry) => entry.name !== name,
  );
  registry.legacyInternalHooks.push(
    ...nextRegistrations.map((entry) => ({ ...entry, pluginId: name, name })),
  );
  return previous;
}

export function clearLegacyPluginInternalHooks(): void {
  const context = getPluginRegistrationContext();
  const live = context ? [context.registry] : collectLivePluginRegistries();
  for (const registry of live.length > 0 ? live : [requireActivePluginRegistry()]) {
    registry.legacyInternalHooks.length = 0;
  }
}

export function snapshotLegacyPluginInternalHooks(): LegacyPluginInternalHookState {
  const state: LegacyPluginInternalHookState = new Map();
  for (const entry of requireActivePluginRegistry().legacyInternalHooks) {
    state.set(entry.name, [
      ...(state.get(entry.name) ?? []),
      { event: entry.event, handler: entry.handler },
    ]);
  }
  return state;
}

export function restoreLegacyPluginInternalHooks(state: LegacyPluginInternalHookState): void {
  clearLegacyPluginInternalHooks();
  for (const [name, registrations] of state) {
    replaceLegacyPluginInternalHook(name, registrations);
  }
}
