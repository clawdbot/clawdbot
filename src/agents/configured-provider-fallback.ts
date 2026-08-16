/**
 * Chooses a configured provider/model fallback when defaults are absent from
 * the user's model config.
 */
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.js";

type ProviderModelRef = {
  provider: string;
  model: string;
};

/** Resolve the first configured provider/model that can replace a missing default. */
export function resolveConfiguredProviderFallback(params: {
  cfg: Pick<OpenClawConfig, "models">;
  defaultProvider: string;
  defaultModel: string | undefined;
}): ProviderModelRef | null {
  const configuredProviders = params.cfg.models?.providers;
  if (!configuredProviders || typeof configuredProviders !== "object") {
    return null;
  }
  const defaultProviderConfig = findNormalizedProviderValue(
    configuredProviders,
    params.defaultProvider,
  );
  const defaultModel = params.defaultModel?.trim();
  const defaultProviderHasConfiguredModel =
    Array.isArray(defaultProviderConfig?.models) &&
    defaultProviderConfig.models.some((model) => Boolean(model?.id));
  const defaultProviderHasDefaultModel =
    defaultModel !== undefined &&
    Array.isArray(defaultProviderConfig?.models) &&
    defaultProviderConfig.models.some((model) => model?.id === defaultModel);
  if (defaultProviderHasConfiguredModel && (!defaultModel || defaultProviderHasDefaultModel)) {
    return null;
  }
  // Fall back to the first provider with at least one configured model, preserving
  // config insertion order as operator preference.
  const availableProvider = Object.entries(configuredProviders).find(
    ([, providerCfg]) =>
      providerCfg &&
      Array.isArray(providerCfg.models) &&
      providerCfg.models.length > 0 &&
      providerCfg.models[0]?.id,
  );
  if (!availableProvider) {
    return null;
  }
  const [provider, providerCfg] = availableProvider;
  const models = providerCfg.models;
  if (!Array.isArray(models) || !models[0]?.id) {
    return null;
  }
  return { provider: normalizeProviderId(provider), model: models[0].id };
}
