// Maintains interactive plugin registry entries discovered from manifests.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizePluginInteractiveNamespace,
  resolvePluginInteractiveMatch,
  toPluginInteractiveRegistryKey,
  validatePluginInteractiveNamespace,
} from "./interactive-shared.js";
import { clearPluginInteractiveHandlersState } from "./interactive-state.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  getActivePluginChannelRegistry,
  getPluginRegistrationContext,
  requireActivePluginChannelRegistry,
  resolveDirectPluginRegistrationOwner,
} from "./runtime.js";
import type { PluginInteractiveHandlerRegistration } from "./types.js";

/** Registered interactive handler with owning plugin metadata. */
export type RegisteredInteractiveHandler = PluginInteractiveHandlerRegistration & {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};

const getInteractiveHandlers = () => getActivePluginChannelRegistry()?.interactiveHandlers ?? [];

/** Registration result for plugin interactive namespace handlers. */
type InteractiveRegistrationResult = {
  ok: boolean;
  error?: string;
};

function requireInteractiveRegistrationRegistry(): PluginRegistry {
  return getPluginRegistrationContext()?.registry ?? requireActivePluginChannelRegistry();
}

function asInteractiveHandlerLookup(registrations: readonly RegisteredInteractiveHandler[]) {
  return {
    get: (key: string) =>
      registrations.find(
        (entry) => toPluginInteractiveRegistryKey(entry.channel, entry.namespace) === key,
      ),
  };
}

/** Resolves a channel payload to a registered plugin interactive namespace handler. */
export function resolvePluginInteractiveNamespaceMatch(
  channel: string,
  data: string,
): { registration: RegisteredInteractiveHandler; namespace: string; payload: string } | null {
  return resolvePluginInteractiveMatch({
    interactiveHandlers: asInteractiveHandlerLookup(getInteractiveHandlers()),
    channel,
    data,
  });
}

/** Resolves a handler from registry-owned registrations without changing global state. */
export function resolvePluginInteractiveRegistrationsMatch(
  registrations: readonly RegisteredInteractiveHandler[],
  channel: string,
  data: string,
): { registration: RegisteredInteractiveHandler; namespace: string; payload: string } | null {
  return resolvePluginInteractiveMatch({
    interactiveHandlers: asInteractiveHandlerLookup(registrations),
    channel,
    data,
  });
}

/** Registers one plugin interactive namespace for a channel. */
function registerPluginInteractiveHandlerWithOptions(
  registrations: PluginRegistry["interactiveHandlers"],
  pluginId: string,
  registration: PluginInteractiveHandlerRegistration,
  opts?: { pluginName?: string; pluginRoot?: string },
): InteractiveRegistrationResult {
  const namespace = normalizePluginInteractiveNamespace(registration.namespace);
  const validationError = validatePluginInteractiveNamespace(namespace);
  if (validationError) {
    return { ok: false, error: validationError };
  }
  const key = toPluginInteractiveRegistryKey(registration.channel, namespace);
  const existing = registrations.find(
    (entry) => toPluginInteractiveRegistryKey(entry.channel, entry.namespace) === key,
  );
  if (existing) {
    return {
      ok: false,
      error: `Interactive handler namespace "${namespace}" already registered by plugin "${existing.pluginId}"`,
    };
  }
  registrations.push({
    ...registration,
    namespace,
    channel: normalizeOptionalLowercaseString(registration.channel) ?? "",
    pluginId,
    pluginName: opts?.pluginName,
    pluginRoot: opts?.pluginRoot,
  });
  return { ok: true };
}

/** Registers one process-global interactive handler. */
export function registerPluginInteractiveHandler(
  pluginId: string,
  registration: PluginInteractiveHandlerRegistration,
  opts?: { pluginName?: string; pluginRoot?: string },
): InteractiveRegistrationResult {
  return registerPluginInteractiveHandlerWithOptions(
    requireInteractiveRegistrationRegistry().interactiveHandlers,
    resolveDirectPluginRegistrationOwner(pluginId) ?? pluginId,
    registration,
    opts,
  );
}

/** Registers one handler whose lifetime follows its owning plugin registry. */
export function registerPluginInteractiveHandlerInRegistry(
  registry: PluginRegistry,
  pluginId: string,
  registration: PluginInteractiveHandlerRegistration,
  opts?: { pluginName?: string; pluginRoot?: string },
): InteractiveRegistrationResult {
  return registerPluginInteractiveHandlerWithOptions(
    registry.interactiveHandlers,
    pluginId,
    registration,
    opts,
  );
}

/** Registers one compatibility handler in the currently selected channel registry. */
export function registerRegistryPluginInteractiveHandler(
  pluginId: string,
  registration: PluginInteractiveHandlerRegistration,
  opts?: { pluginName?: string; pluginRoot?: string },
): InteractiveRegistrationResult {
  return registerPluginInteractiveHandlerWithOptions(
    requireInteractiveRegistrationRegistry().interactiveHandlers,
    resolveDirectPluginRegistrationOwner(pluginId) ?? pluginId,
    registration,
    opts,
  );
}

/** Clears all active plugin interactive handlers. */
export function clearPluginInteractiveHandlers(): void {
  requireActivePluginChannelRegistry().interactiveHandlers.length = 0;
  clearPluginInteractiveHandlersState();
}
