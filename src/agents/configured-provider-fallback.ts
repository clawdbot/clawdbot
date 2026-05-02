import type { OpenClawConfig } from "../config/types.js";

type ProviderModelRef = {
  provider: string;
  model: string;
};

export function resolveConfiguredProviderFallback(params: {
  cfg: Pick<OpenClawConfig, "models">;
  defaultProvider: string;
  defaultModel?: string;
}): ProviderModelRef | null {
  const configuredProviders = params.cfg.models?.providers;
  if (!configuredProviders || typeof configuredProviders !== "object") {
    return null;
  }
  const defaultProviderConfig = configuredProviders[params.defaultProvider];
  const defaultModel = params.defaultModel?.trim();
  const defaultProviderHasDefaultModel =
    !!defaultProviderConfig &&
    !!defaultModel &&
    Array.isArray(defaultProviderConfig.models) &&
    defaultProviderConfig.models.some((model) => model?.id === defaultModel);
  if (defaultProviderConfig && (!defaultModel || defaultProviderHasDefaultModel)) {
    return null;
  }
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
  return { provider, model: providerCfg.models[0].id };
}
