import type { OpenClawConfig } from "../config/types.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingCapabilityRegistry, MediaUnderstandingProvider } from "./types.js";

type ConfigProvider = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]
>;

type ConfigProviderModel = NonNullable<ConfigProvider["models"]>[number];

function mergeProviderCapabilities(
  registry: MediaUnderstandingCapabilityRegistry,
  provider: Pick<MediaUnderstandingProvider, "id" | "capabilities">,
) {
  const normalizedKey = normalizeMediaProviderId(provider.id);
  const existing = registry.get(normalizedKey);
  registry.set(normalizedKey, {
    capabilities: provider.capabilities ?? existing?.capabilities,
  });
}

export function buildMediaUnderstandingCapabilityRegistry(
  cfg?: OpenClawConfig,
): MediaUnderstandingCapabilityRegistry {
  const registry: MediaUnderstandingCapabilityRegistry = new Map();

  for (const provider of resolvePluginCapabilityProviders({
    key: "mediaUnderstandingProviders",
    cfg,
  })) {
    mergeProviderCapabilities(registry, provider);
  }

  const configProviders = cfg?.models?.providers;
  if (configProviders && typeof configProviders === "object") {
    for (const [providerKey, providerCfg] of Object.entries(configProviders)) {
      if (!providerKey?.trim()) {
        continue;
      }
      const normalizedKey = normalizeMediaProviderId(providerKey);
      if (registry.has(normalizedKey)) {
        continue;
      }
      const models = providerCfg.models ?? [];
      const hasImageModel = models.some(
        (model: ConfigProviderModel) =>
          Array.isArray(model?.input) && model.input.includes("image"),
      );
      if (!hasImageModel) {
        continue;
      }
      mergeProviderCapabilities(registry, {
        id: normalizedKey,
        capabilities: ["image"],
      });
    }
  }

  return registry;
}
