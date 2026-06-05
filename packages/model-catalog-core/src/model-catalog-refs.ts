// Model Catalog Core module implements model catalog refs behavior.
import { normalizeLowercaseStringOrEmpty } from "./provider-id.js";

// Stable model catalog ref and merge-key builders.

/** Normalize provider ids for catalog refs. */
export function normalizeModelCatalogProviderId(provider: string): string {
  return normalizeLowercaseStringOrEmpty(provider);
}

/** Build a provider/model catalog reference. */
export function buildModelCatalogRef(provider: string, modelId: string): string {
  return `${normalizeModelCatalogProviderId(provider)}/${modelId}`;
}

/** Build a case-insensitive merge key for provider/model rows. */
export function buildModelCatalogMergeKey(provider: string, modelId: string): string {
  return `${normalizeModelCatalogProviderId(provider)}::${normalizeLowercaseStringOrEmpty(modelId)}`;
}
