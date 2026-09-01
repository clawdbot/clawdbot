import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SessionDiscussionProvider } from "./registry-contribution-types.js";
import {
  getActivePluginChannelRegistry,
  getPluginRegistrationContext,
  requireActivePluginChannelRegistry,
} from "./runtime.js";

export type {
  SessionDiscussionInfo,
  SessionDiscussionProvider,
  SessionDiscussionState,
} from "./registry-contribution-types.js";

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

export function clearSessionDiscussionProvider(): void {
  requireActivePluginChannelRegistry().sessionDiscussionProviders.clear();
}
