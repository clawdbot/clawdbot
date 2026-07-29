// Maintains interactive plugin registry entries discovered from manifests.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizePluginInteractiveNamespace,
  resolvePluginInteractiveMatch,
  toPluginInteractiveRegistryKey,
  validatePluginInteractiveNamespace,
} from "./interactive-shared.js";
import {
  clearPluginInteractiveHandlerRegistrationsState,
  clearPluginInteractiveHandlersState,
  getPluginInteractiveHandlersState,
  type RegisteredInteractiveHandler,
} from "./interactive-state.js";
import type { PluginInteractiveHandlerRegistration } from "./types.js";

/** Registration result for plugin interactive namespace handlers. */
type InteractiveRegistrationResult = {
  ok: boolean;
  error?: string;
};

/** Resolves a channel payload to a registered plugin interactive namespace handler. */
export function resolvePluginInteractiveNamespaceMatch(
  channel: string,
  data: string,
): { registration: RegisteredInteractiveHandler; namespace: string; payload: string } | null {
  return resolvePluginInteractiveMatch({
    interactiveHandlers: getPluginInteractiveHandlersState(),
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
    interactiveHandlers: {
      get: (key) =>
        registrations.find(
          (registration) =>
            toPluginInteractiveRegistryKey(registration.channel, registration.namespace) === key,
        ),
    },
    channel,
    data,
  });
}

/** Registers one plugin interactive namespace for a channel. */
function registerPluginInteractiveHandlerWithOptions(
  pluginId: string,
  registration: PluginInteractiveHandlerRegistration,
  opts?: { pluginName?: string; pluginRoot?: string; registryOwned?: true },
): InteractiveRegistrationResult {
  const interactiveHandlers = getPluginInteractiveHandlersState();
  const namespace = normalizePluginInteractiveNamespace(registration.namespace);
  const validationError = validatePluginInteractiveNamespace(namespace);
  if (validationError) {
    return { ok: false, error: validationError };
  }
  const key = toPluginInteractiveRegistryKey(registration.channel, namespace);
  const existing = interactiveHandlers.get(key);
  if (existing) {
    return {
      ok: false,
      error: `Interactive handler namespace "${namespace}" already registered by plugin "${existing.pluginId}"`,
    };
  }
  interactiveHandlers.set(key, {
    ...registration,
    namespace,
    channel: normalizeOptionalLowercaseString(registration.channel) ?? "",
    pluginId,
    pluginName: opts?.pluginName,
    pluginRoot: opts?.pluginRoot,
    registryOwned: opts?.registryOwned,
  });
  return { ok: true };
}

/** Registers one process-global interactive handler. */
export function registerPluginInteractiveHandler(
  pluginId: string,
  registration: PluginInteractiveHandlerRegistration,
  opts?: { pluginName?: string; pluginRoot?: string },
): InteractiveRegistrationResult {
  return registerPluginInteractiveHandlerWithOptions(pluginId, registration, opts);
}

/** Registers one handler whose lifetime follows its owning plugin registry. */
export function registerRegistryPluginInteractiveHandler(
  pluginId: string,
  registration: PluginInteractiveHandlerRegistration,
  opts?: { pluginName?: string; pluginRoot?: string },
): InteractiveRegistrationResult {
  return registerPluginInteractiveHandlerWithOptions(pluginId, registration, {
    ...opts,
    registryOwned: true,
  });
}

/** Clears all active plugin interactive handlers. */
export function clearPluginInteractiveHandlers(): void {
  clearPluginInteractiveHandlersState();
}

/** Clears stored plugin interactive handler registrations. */
function clearPluginInteractiveHandlerRegistrations(): void {
  clearPluginInteractiveHandlerRegistrationsState();
}

/** Clears active interactive handlers owned by one plugin. */
export function clearPluginInteractiveHandlersForPlugin(pluginId: string): void {
  const interactiveHandlers = getPluginInteractiveHandlersState();
  for (const [key, value] of interactiveHandlers.entries()) {
    if (value.pluginId === pluginId) {
      interactiveHandlers.delete(key);
    }
  }
}

/** Lists active plugin interactive handlers. */
export function listPluginInteractiveHandlers(): RegisteredInteractiveHandler[] {
  return Array.from(getPluginInteractiveHandlersState().values());
}

/** Restores active plugin interactive handlers from a saved registry snapshot. */
export function restorePluginInteractiveHandlers(
  registrations: readonly RegisteredInteractiveHandler[],
): void {
  clearPluginInteractiveHandlerRegistrations();
  const interactiveHandlers = getPluginInteractiveHandlersState();
  for (const registration of registrations) {
    const namespace = normalizePluginInteractiveNamespace(registration.namespace);
    if (!namespace) {
      continue;
    }
    interactiveHandlers.set(toPluginInteractiveRegistryKey(registration.channel, namespace), {
      ...registration,
      namespace,
      channel: normalizeOptionalLowercaseString(registration.channel) ?? "",
    });
  }
}
