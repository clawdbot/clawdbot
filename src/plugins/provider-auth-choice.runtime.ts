// Runtime boundary for resolving provider auth choices from plugins.
import {
  resolveProviderPluginChoice as resolveProviderPluginChoiceImpl,
  runProviderModelSelectedHook as runProviderModelSelectedHookImpl,
} from "./provider-wizard.js";
import { resolvePluginProviders as resolvePluginProvidersImpl } from "./providers.runtime.js";
import { resolvePluginSetupProvider as resolvePluginSetupProviderImpl } from "./setup-registry.js";

type ResolveProviderPluginChoice =
  typeof import("./provider-wizard.js").resolveProviderPluginChoice;
type RunProviderModelSelectedHook =
  typeof import("./provider-wizard.js").runProviderModelSelectedHook;
type ResolvePluginProviders = typeof import("./providers.runtime.js").resolvePluginProviders;
type ResolvePluginSetupProvider = typeof import("./setup-registry.js").resolvePluginSetupProvider;

/** Runtime wrapper for provider plugin wizard choice resolution. */
export function resolveProviderPluginChoice(
  ...args: Parameters<ResolveProviderPluginChoice>
): ReturnType<ResolveProviderPluginChoice> {
  return resolveProviderPluginChoiceImpl(...args);
}

/** Runtime wrapper for provider model-selected hook dispatch. */
export function runProviderModelSelectedHook(
  ...args: Parameters<RunProviderModelSelectedHook>
): ReturnType<RunProviderModelSelectedHook> {
  return runProviderModelSelectedHookImpl(...args);
}

/** Runtime wrapper for registered model provider discovery. */
export function resolvePluginProviders(
  ...args: Parameters<ResolvePluginProviders>
): ReturnType<ResolvePluginProviders> {
  return resolvePluginProvidersImpl(...args);
}

/** Runtime wrapper for plugin setup-provider discovery. */
export function resolvePluginSetupProvider(
  ...args: Parameters<ResolvePluginSetupProvider>
): ReturnType<ResolvePluginSetupProvider> {
  return resolvePluginSetupProviderImpl(...args);
}
