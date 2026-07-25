// Model Catalog Core module implements model catalog refs behavior.
import { normalizeLowercaseStringOrEmpty } from "./provider-id.js";

// Stable model catalog ref and merge-key builders.

export type ModelCatalogRef = {
  provider: string;
  modelId: string;
};

export type ProviderModelRef = {
  provider: string;
  model: string;
};

/** Normalize provider ids for catalog refs. */
export function normalizeModelCatalogProviderId(provider: string): string {
  return normalizeLowercaseStringOrEmpty(provider);
}

/** Build a provider/model catalog reference. */
export function buildModelCatalogRef(provider: string, modelId: string): string {
  return `${normalizeModelCatalogProviderId(provider)}/${modelId}`;
}

/** Parse a strict provider/model reference without normalizing either segment. */
export function parseProviderModelRef(value: string): ProviderModelRef | null {
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    return null;
  }
  const provider = trimmed.slice(0, slashIndex).trim();
  const model = trimmed.slice(slashIndex + 1).trim();
  return provider && model ? { provider, model } : null;
}

/** Parse a strict provider/model catalog reference. */
export function parseModelCatalogRef(value: string): ModelCatalogRef | null {
  const parsed = parseProviderModelRef(value);
  if (!parsed) {
    return null;
  }
  return {
    provider: normalizeModelCatalogProviderId(parsed.provider),
    modelId: parsed.model,
  };
}

/** Build a case-insensitive merge key for provider/model rows. */
export function buildModelCatalogMergeKey(provider: string, modelId: string): string {
  return `${normalizeModelCatalogProviderId(provider)}::${normalizeLowercaseStringOrEmpty(modelId)}`;
}
