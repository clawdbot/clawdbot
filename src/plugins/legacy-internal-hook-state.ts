import type { InternalHookHandler } from "../hooks/internal-hook-types.js";
import {
  getActivePluginRegistry,
  getPluginRegistrationContext,
  requireActivePluginRegistry,
} from "./runtime.js";

function listActiveRegistrations() {
  return getActivePluginRegistry()?.legacyInternalHooks ?? [];
}

export function listLegacyPluginInternalHooks(event: string): InternalHookHandler[] {
  return listActiveRegistrations()
    .filter((registration) => registration.event === event)
    .map((registration) => registration.handler);
}

export function listLegacyPluginInternalHookEventKeys(): string[] {
  return [...new Set(listActiveRegistrations().map((registration) => registration.event))];
}

export function clearLegacyPluginInternalHooks(): void {
  const context = getPluginRegistrationContext();
  (context?.registry ?? requireActivePluginRegistry()).legacyInternalHooks.length = 0;
}
