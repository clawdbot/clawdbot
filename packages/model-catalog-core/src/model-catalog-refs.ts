// Model Catalog Core module implements model catalog refs behavior.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeProviderId } from "./provider-id.js";

export { normalizeProviderId as normalizeModelCatalogProviderId } from "./provider-id.js";

// Stable model catalog ref and merge-key builders.

export type ModelCatalogRef = {
  provider: string;
  modelId: string;
};

export type ProviderModelRef = {
  provider: string;
  model: string;
};

type ModelSourceSuffix = {
  base: string;
  source: "cloud" | "local";
};

function parseModelSourceSuffix(modelRef: string): ModelSourceSuffix | undefined {
  const sourceSeparator = modelRef.lastIndexOf(":");
  if (sourceSeparator < 0) {
    return undefined;
  }
  const source = modelRef.slice(sourceSeparator + 1);
  if (source === "cloud" || source === "local") {
    return { base: modelRef.slice(0, sourceSeparator), source };
  }
  if (!source.includes("/") && source.endsWith("-cloud")) {
    return { base: modelRef.slice(0, -"-cloud".length), source: "cloud" };
  }
  return undefined;
}

/** Recognizes one unambiguous hosted source suffix on a bare or qualified model ref. */
export function isCloudModelRef(modelRef: string | undefined): boolean {
  const normalized = modelRef?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const source = parseModelSourceSuffix(normalized);
  return source?.source === "cloud" && parseModelSourceSuffix(source.base) === undefined;
}

/** Build a provider/model catalog reference. */
export function buildModelCatalogRef(provider: string, modelId: string): string {
  return `${normalizeProviderId(provider)}/${modelId}`;
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
    provider: normalizeProviderId(parsed.provider),
    modelId: parsed.model,
  };
}

/** Build a case-insensitive merge key for provider/model rows. */
export function buildModelCatalogMergeKey(provider: string, modelId: string): string {
  return `${normalizeProviderId(provider)}::${normalizeLowercaseStringOrEmpty(modelId)}`;
}
