import type { OpenClawConfig } from "../config/types.js";
import { normalizeMediaProviderId } from "./provider-id.js";

type ConfigProvider = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]
>;

type ConfigProviderModel = NonNullable<ConfigProvider["models"]>[number];

function hasImageCapableModel(providerCfg: ConfigProvider): boolean {
  const models = providerCfg.models ?? [];
  return models.some(
    (model: ConfigProviderModel) => Array.isArray(model?.input) && model.input.includes("image"),
  );
}

export function resolveImageCapableConfigProviderIds(cfg?: OpenClawConfig): string[] {
  const configProviders = cfg?.models?.providers;
  if (!configProviders || typeof configProviders !== "object") {
    return [];
  }

  const providerIds: string[] = [];
  for (const [providerKey, providerCfg] of Object.entries(configProviders)) {
    if (!providerKey?.trim() || !hasImageCapableModel(providerCfg)) {
      continue;
    }
    providerIds.push(normalizeMediaProviderId(providerKey));
  }
  return providerIds;
}
