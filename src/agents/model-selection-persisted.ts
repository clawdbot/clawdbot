// Persisted model metadata normalization without loading the broader selection runtime.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  allowsPluginModelNormalization,
  hasExactConfiguredProviderModel,
} from "./configured-provider-model.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelFallbackRouteResolution } from "./model-fallback.types.js";
import {
  type ModelManifestNormalizationContext,
  type ModelRef,
  normalizeConfiguredProviderCatalogModelId,
  normalizeModelRef,
  normalizeProviderId,
} from "./model-ref-shared.js";
import { parseModelRefParts } from "./model-selection-normalize.js";

export function resolvePersistedOverrideModelRef(
  params: {
    defaultProvider?: unknown;
    overrideProvider?: unknown;
    overrideModel?: unknown;
    overrideRouteResolution?: ModelFallbackRouteResolution;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const defaultProvider = normalizeOptionalString(params.defaultProvider) ?? DEFAULT_PROVIDER;
  const overrideProvider = normalizeOptionalString(params.overrideProvider);
  const overrideModel = normalizeOptionalString(params.overrideModel);
  if (!overrideModel) {
    return null;
  }
  const encodedOverride = overrideProvider ? `${overrideProvider}/${overrideModel}` : overrideModel;
  const ref = parseModelRefParts(encodedOverride, defaultProvider);
  if (!ref) {
    return { provider: overrideProvider || defaultProvider, model: overrideModel };
  }
  const configuredModel = { cfg: params.config, ...ref };
  // Exact configured ids may contain their own provider prefix. Preserve those
  // paths before generic normalization, while retaining static catalog policy.
  if (hasExactConfiguredProviderModel(configuredModel)) {
    const provider = normalizeProviderId(ref.provider);
    return {
      provider,
      model: normalizeConfiguredProviderCatalogModelId(provider, ref.model, params),
    };
  }
  // Persisted resolved selections must not run executable normalization again.
  // Keep static parsing and manifest policy; generic fallback route resolution is separate.
  return normalizeModelRef(ref.provider, ref.model, {
    ...params,
    allowPluginNormalization:
      params.overrideRouteResolution !== "resolved" &&
      params.allowPluginNormalization !== false &&
      allowsPluginModelNormalization(configuredModel),
  });
}

export function normalizeStoredOverrideModel(params: {
  providerOverride?: unknown;
  modelOverride?: unknown;
}): { providerOverride?: string; modelOverride?: string } {
  const providerOverride = normalizeOptionalString(params.providerOverride);
  const modelOverride = normalizeOptionalString(params.modelOverride);
  if (!providerOverride || !modelOverride) {
    return {
      providerOverride,
      modelOverride,
    };
  }

  const providerPrefix = `${providerOverride.toLowerCase()}/`;
  return {
    providerOverride,
    modelOverride: modelOverride.toLowerCase().startsWith(providerPrefix)
      ? modelOverride.slice(providerOverride.length + 1).trim() || modelOverride
      : modelOverride,
  };
}
