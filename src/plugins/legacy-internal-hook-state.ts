import {
  registerInternalHook,
  unregisterInternalHook,
  type InternalHookHandler,
} from "../hooks/internal-hooks.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type LegacyPluginInternalHookRegistration = {
  event: string;
  handler: InternalHookHandler;
};

export type LegacyPluginInternalHookState = Map<string, LegacyPluginInternalHookRegistration[]>;

const LEGACY_PLUGIN_INTERNAL_HOOKS_KEY = Symbol.for("openclaw.activePluginHookRegistrations");
const registrations = resolveGlobalSingleton<LegacyPluginInternalHookState>(
  LEGACY_PLUGIN_INTERNAL_HOOKS_KEY,
  () => new Map(),
);

function cloneRegistrations(
  values: readonly LegacyPluginInternalHookRegistration[],
): LegacyPluginInternalHookRegistration[] {
  return values.map((registration) => ({ ...registration }));
}

export function replaceLegacyPluginInternalHook(
  name: string,
  nextRegistrations: readonly LegacyPluginInternalHookRegistration[],
): LegacyPluginInternalHookRegistration[] {
  const previousRegistrations = cloneRegistrations(registrations.get(name) ?? []);
  for (const registration of registrations.get(name) ?? []) {
    unregisterInternalHook(registration.event, registration.handler);
  }
  for (const registration of nextRegistrations) {
    registerInternalHook(registration.event, registration.handler);
  }
  if (nextRegistrations.length === 0) {
    registrations.delete(name);
  } else {
    registrations.set(name, cloneRegistrations(nextRegistrations));
  }
  return previousRegistrations;
}

export function clearLegacyPluginInternalHooks(): void {
  for (const name of registrations.keys()) {
    replaceLegacyPluginInternalHook(name, []);
  }
}

export function snapshotLegacyPluginInternalHooks(): LegacyPluginInternalHookState {
  return new Map(
    [...registrations].map(([name, hookRegistrations]) => [
      name,
      cloneRegistrations(hookRegistrations),
    ]),
  );
}

export function restoreLegacyPluginInternalHooks(state: LegacyPluginInternalHookState): void {
  clearLegacyPluginInternalHooks();
  for (const [name, hookRegistrations] of state) {
    replaceLegacyPluginInternalHook(name, hookRegistrations);
  }
}
