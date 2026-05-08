import type { OpenClawConfig } from "../config/types.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "../plugins/capability-provider-runtime.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
export { normalizeSpeechProviderId } from "./provider-registry-core.js";
import {
  createSpeechProviderRegistry,
  type SpeechProviderRegistryResolver,
} from "./provider-registry-core.js";

function resolveSpeechProviderPluginEntries(cfg?: OpenClawConfig): SpeechProviderPlugin[] {
  return resolvePluginCapabilityProviders({
    key: "speechProviders",
    cfg,
  });
}

function resolveLoadedSpeechProviderPluginEntries(): SpeechProviderPlugin[] {
  return (getActiveRuntimePluginRegistry()?.speechProviders ?? []).map((entry) => entry.provider);
}

const defaultSpeechProviderRegistryResolver: SpeechProviderRegistryResolver = {
  getProvider: (providerId, cfg) =>
    resolvePluginCapabilityProvider({
      key: "speechProviders",
      providerId,
      cfg,
    }),
  listProviders: resolveSpeechProviderPluginEntries,
};

const defaultSpeechProviderRegistry = createSpeechProviderRegistry(
  defaultSpeechProviderRegistryResolver,
);

const loadedSpeechProviderRegistry = createSpeechProviderRegistry({
  getProvider: (providerId) =>
    resolveLoadedSpeechProviderPluginEntries().find((provider) => {
      if (provider.id === providerId) {
        return true;
      }
      return provider.aliases?.includes(providerId) ?? false;
    }),
  listProviders: () => resolveLoadedSpeechProviderPluginEntries(),
});

export const listSpeechProviders = defaultSpeechProviderRegistry.listSpeechProviders;
export const listLoadedSpeechProviders = loadedSpeechProviderRegistry.listSpeechProviders;
export const getSpeechProvider = defaultSpeechProviderRegistry.getSpeechProvider;
export const canonicalizeSpeechProviderId =
  defaultSpeechProviderRegistry.canonicalizeSpeechProviderId;
