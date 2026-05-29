import {
  normalizeGooglePreviewModelId,
  normalizeTogetherModelId,
} from "../plugin-sdk/provider-model-id-normalize.js";
import { normalizeProviderModelIdWithManifest } from "../plugins/manifest-model-id-normalization.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeProviderId } from "./provider-id.js";

type StaticModelRef = {
  provider: string;
  model: string;
};

export type ProviderModelIdNormalizationOptions = {
  allowManifestNormalization?: boolean;
  manifestPlugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};

export function modelKey(provider: string, model: string): string {
  const providerId = provider.trim();
  const modelId = model.trim();
  if (!providerId) {
    return modelId;
  }
  if (!modelId) {
    return providerId;
  }
  return normalizeLowercaseStringOrEmpty(modelId).startsWith(
    `${normalizeLowercaseStringOrEmpty(providerId)}/`,
  )
    ? modelId
    : `${providerId}/${modelId}`;
}

export function normalizeStaticProviderModelId(
  provider: string,
  model: string,
  options: ProviderModelIdNormalizationOptions = {},
): string {
  const normalizedProvider = normalizeProviderId(provider);
  if (options.allowManifestNormalization === false) {
    return normalizeBuiltInProviderModelId(normalizedProvider, model);
  }
  const manifestModelId =
    normalizeProviderModelIdWithManifest({
      provider: normalizedProvider,
      plugins: options.manifestPlugins,
      context: {
        provider: normalizedProvider,
        modelId: model,
      },
    }) ?? model;
  return normalizeBuiltInProviderModelId(normalizedProvider, manifestModelId);
}

function normalizeBuiltInProviderModelId(provider: string, model: string): string {
  if (provider === "google" || provider === "google-gemini-cli" || provider === "google-vertex") {
    return normalizeGooglePreviewModelId(model);
  }
  if (provider === "openrouter") {
    const trimmed = model.trim();
    return trimmed && !trimmed.includes("/") ? `openrouter/${trimmed}` : model;
  }
  if (provider === "xai") {
    const xaiAliases: Record<string, string> = {
      "grok-4-fast-reasoning": "grok-4-fast",
      "grok-4-1-fast-reasoning": "grok-4-1-fast",
      "grok-4.20-experimental-beta-0304-reasoning": "grok-4.20-beta-latest-reasoning",
      "grok-4.20-experimental-beta-0304-non-reasoning": "grok-4.20-beta-latest-non-reasoning",
      "grok-4.20-reasoning": "grok-4.20-beta-latest-reasoning",
      "grok-4.20-non-reasoning": "grok-4.20-beta-latest-non-reasoning",
    };
    return xaiAliases[normalizeLowercaseStringOrEmpty(model)] ?? model;
  }
  if (provider === "together") {
    return normalizeTogetherModelId(model);
  }
  return model;
}

export function normalizeConfiguredProviderCatalogModelId(
  provider: string,
  model: string,
  options: ProviderModelIdNormalizationOptions = {},
): string {
  const providerModel = normalizeStaticProviderModelId(provider, model, options);
  const googlePrefix = "google/";
  if (!providerModel.startsWith(googlePrefix)) {
    const slash = providerModel.indexOf("/");
    if (slash <= 0 || slash >= providerModel.length - 1) {
      return providerModel;
    }
    const prefix = providerModel.slice(0, slash + 1);
    const suffix = providerModel.slice(slash + 1);
    if (!suffix.startsWith(googlePrefix)) {
      return providerModel;
    }
    const normalizedSuffix = normalizeGooglePreviewModelId(suffix);
    return normalizedSuffix === suffix ? providerModel : `${prefix}${normalizedSuffix}`;
  }
  const modelId = providerModel.slice(googlePrefix.length);
  const normalizedModelId = normalizeGooglePreviewModelId(modelId);
  return normalizedModelId === modelId ? providerModel : `${googlePrefix}${normalizedModelId}`;
}

function parseStaticModelRef(raw: string, defaultProvider: string): StaticModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  const providerRaw = slash === -1 ? defaultProvider : trimmed.slice(0, slash).trim();
  const modelRaw = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
  if (!providerRaw || !modelRaw) {
    return null;
  }
  const provider = normalizeProviderId(providerRaw);
  return {
    provider,
    model: normalizeStaticProviderModelId(provider, modelRaw),
  };
}

export function resolveStaticAllowlistModelKey(
  raw: string,
  defaultProvider: string,
): string | null {
  const parsed = parseStaticModelRef(raw, defaultProvider);
  if (!parsed) {
    return null;
  }
  return modelKey(parsed.provider, parsed.model);
}

export function formatLiteralProviderPrefixedModelRef(provider: string, modelRef: string): string {
  const providerId = normalizeProviderId(provider);
  const trimmedRef = modelRef.trim();
  if (!providerId || !trimmedRef) {
    return trimmedRef;
  }
  const normalizedRef = normalizeLowercaseStringOrEmpty(trimmedRef);
  const literalPrefix = `${providerId}/${providerId}/`;
  if (normalizedRef.startsWith(literalPrefix)) {
    return trimmedRef;
  }
  return normalizedRef.startsWith(`${providerId}/`) ? `${providerId}/${trimmedRef}` : trimmedRef;
}
