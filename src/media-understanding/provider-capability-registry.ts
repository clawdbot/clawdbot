// Capability metadata for the configured shared media model entries.
import { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolvePluginCapabilityProvider } from "../plugins/capability-provider-runtime.js";
import { resolveImageCapableConfigProviderIds } from "./config-provider-models.js";
import { resolveConfiguredMediaEntryCapabilities } from "./entry-capabilities.js";
import type { MediaUnderstandingCapabilityRegistry } from "./types.js";

/** Resolves capability metadata for configured shared media model providers. */
export function buildMediaUnderstandingCapabilityRegistry(
  cfg?: OpenClawConfig,
): MediaUnderstandingCapabilityRegistry {
  const registry: MediaUnderstandingCapabilityRegistry = new Map();
  const providerIds = new Set<string>();
  for (const entry of cfg?.tools?.media?.models ?? []) {
    if (
      typeof entry?.provider === "string" &&
      (entry.type ?? (entry.command ? "cli" : "provider")) === "provider" &&
      !resolveConfiguredMediaEntryCapabilities(entry)
    ) {
      const providerId = normalizeMediaProviderId(entry.provider);
      if (providerId) {
        providerIds.add(providerId);
      }
    }
  }
  for (const providerId of providerIds) {
    const provider = resolvePluginCapabilityProvider({
      key: "mediaUnderstandingProviders",
      providerId,
      cfg,
    });
    if (provider) {
      // Keep canonical keys: runtime aliases do not independently opt entries into inference.
      registry.set(normalizeMediaProviderId(provider.id), { capabilities: provider.capabilities });
    }
  }
  for (const providerId of resolveImageCapableConfigProviderIds(cfg)) {
    // A runtime declaration owns capability truth, including an explicitly absent capability set.
    if (providerIds.has(providerId) && !registry.has(providerId)) {
      registry.set(providerId, { capabilities: ["image"] });
    }
  }
  return registry;
}
