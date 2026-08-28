/** Configured provider rows own exact model ids before plugin normalization. */
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";

type ConfiguredProviderModelParams = {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
};

/** Find the first configured provider without rediscovering its normalized key. */
export function findConfiguredModelProvider(
  cfg: OpenClawConfig | undefined,
  provider: string,
): ModelProviderConfig | undefined {
  return provider.trim()
    ? findNormalizedProviderValue(cfg?.models?.providers, provider)
    : undefined;
}

/** Exact configured model rows must survive provider-owned alias rewriting. */
export function hasExactConfiguredProviderModel(params: ConfiguredProviderModelParams): boolean {
  const model = params.model.trim();
  return Boolean(
    model &&
    findConfiguredModelProvider(params.cfg, params.provider)?.models?.some(
      (entry) => entry.id.trim() === model,
    ),
  );
}

/** Disabled plugins and exact configured rows both prohibit runtime alias rewriting. */
export function allowsPluginModelNormalization(params: ConfiguredProviderModelParams): boolean {
  const provider = findConfiguredModelProvider(params.cfg, params.provider);
  if (!provider) {
    return true;
  }
  if (!normalizePluginsConfig(params.cfg?.plugins).enabled) {
    return false;
  }
  const model = params.model.trim();
  return !model || !(provider.models ?? []).some((entry) => entry.id.trim() === model);
}
