import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getActivePluginChannelRegistry,
  getPluginRegistrationContext,
  requireActivePluginChannelRegistry,
} from "./runtime.js";

export type SessionDiscussionState = "none" | "available" | "open";
export type SessionDiscussionInfo = {
  state: SessionDiscussionState;
  embedUrl?: string;
  openUrl?: string;
};
export type SessionDiscussionProvider = {
  id: string;
  info(params: { sessionKey: string }): Promise<SessionDiscussionInfo>;
  open(params: { sessionKey: string }): Promise<SessionDiscussionInfo>;
};

const log = createSubsystemLogger("plugins/session-discussion");
export function registerSessionDiscussionProvider(provider: SessionDiscussionProvider): void {
  const context = getPluginRegistrationContext();
  const registry = context?.registry ?? requireActivePluginChannelRegistry();
  const pluginId = context?.pluginId ?? provider.id;
  const existing = registry.sessionDiscussionProviders.get(pluginId);
  if (existing) {
    log.warn(`replacing session discussion provider ${existing.provider.id} with ${provider.id}`);
  } else {
    const selected = registry.sessionDiscussionProviders.values().next().value;
    if (selected) {
      log.warn(
        `session discussion provider ${provider.id} registered alongside ${selected.provider.id}; retaining ${selected.provider.id} as the default`,
      );
    }
  }
  registry.sessionDiscussionProviders.set(pluginId, { pluginId, provider });
}

export function getSessionDiscussionProvider(): SessionDiscussionProvider | undefined {
  return getActivePluginChannelRegistry()?.sessionDiscussionProviders.values().next().value
    ?.provider;
}

/** Clears the process-wide provider before a new active plugin registry is assembled. */
export function clearSessionDiscussionProvider(): void {
  requireActivePluginChannelRegistry().sessionDiscussionProviders.clear();
}

/** Restores the provider when a plugin registration transaction does not become active. */
export function restoreSessionDiscussionProvider(
  provider: SessionDiscussionProvider | undefined,
): void {
  const providers = requireActivePluginChannelRegistry().sessionDiscussionProviders;
  providers.clear();
  if (provider) {
    providers.set(provider.id, { pluginId: provider.id, provider });
  }
}
