// Normalizes model input config into provider and model references.
import {
  buildModelCatalogRef,
  normalizeModelCatalogProviderId,
  parseModelCatalogRef,
} from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeBuiltInProviderModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import {
  normalizeGooglePreviewModelId,
  normalizeTogetherModelId,
} from "@openclaw/model-catalog-core/provider-model-id-normalize";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import type { AgentModelEntryConfig } from "./types.agent-defaults.js";
import type { AgentModelConfig, AgentToolModelConfig } from "./types.agents-shared.js";

type AgentModelListLike = {
  primary?: string;
  fallbacks?: string[];
};

type AgentModelInput = AgentModelConfig | AgentToolModelConfig;

/** Returns the primary model ref from either string or object-style agent model config. */
export function resolveAgentModelPrimaryValue(model?: AgentModelInput): string | undefined {
  return resolvePrimaryStringValue(model);
}

/** Returns configured fallback model refs, preserving their configured order. */
export function resolveAgentModelFallbackValues(model?: AgentModelInput): string[] {
  if (!model || typeof model !== "object") {
    return [];
  }
  return Array.isArray(model.fallbacks) ? model.fallbacks : [];
}

/** Returns a positive finite tool timeout rounded down to whole milliseconds. */
export function resolveAgentModelTimeoutMsValue(model?: AgentToolModelConfig): number | undefined {
  if (!model || typeof model !== "object") {
    return undefined;
  }
  return typeof model.timeoutMs === "number" &&
    Number.isFinite(model.timeoutMs) &&
    model.timeoutMs > 0
    ? Math.floor(model.timeoutMs)
    : undefined;
}

/** Converts legacy string model config into the object shape used by model patch helpers. */
export function toAgentModelListLike(model?: AgentModelConfig): AgentModelListLike | undefined {
  if (typeof model === "string") {
    const primary = normalizeOptionalString(model);
    return primary ? { primary } : undefined;
  }
  if (!model || typeof model !== "object") {
    return undefined;
  }
  return model;
}

const GOOGLE_PROVIDER_IDS = new Set(["google", "google-gemini-cli", "google-vertex"]);

/** Canonicalizes provider/model refs before they are persisted to config. */
export function normalizeAgentModelRefForConfig(model: string): string {
  const trimmed = model.trim();
  const parsed = parseModelCatalogRef(trimmed);
  if (!parsed) {
    return trimmed;
  }

  const { provider, modelId: modelSuffix } = parsed;
  const normalizedModel =
    GOOGLE_PROVIDER_IDS.has(provider) || modelSuffix.startsWith("google/")
      ? normalizeGooglePreviewModelId(modelSuffix)
      : provider === "together"
        ? normalizeTogetherModelId(modelSuffix)
        : modelSuffix;
  return buildModelCatalogRef(provider, normalizedModel);
}

/** Resolves an exact model record or its provably equivalent built-in short ref. */
export function resolveAgentModelConfigEntry(params: {
  models: Record<string, AgentModelEntryConfig> | undefined;
  provider: string;
  model: string;
}) {
  const provider = normalizeModelCatalogProviderId(params.provider);
  const model = params.model.trim();
  const key = buildModelCatalogRef(provider, model);
  const shortRef = parseModelCatalogRef(model);
  // A provider's static rule must reconstruct the complete model ID. Prefix
  // similarity alone would borrow settings from an unrelated custom model.
  const equivalentKey =
    shortRef?.provider === provider &&
    normalizeBuiltInProviderModelId(provider, shortRef.modelId) === model
      ? buildModelCatalogRef(provider, shortRef.modelId)
      : undefined;
  const entry =
    params.models?.[key] ?? (equivalentKey ? params.models?.[equivalentKey] : undefined);
  return { key, equivalentKey, entry };
}

/** Normalizes primary/fallback refs without replacing unchanged config values. */
export function normalizeAgentModelSelectionForConfig(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeAgentModelRefForConfig(value);
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  let next = value;
  const assign = (key: string, candidate: unknown) => {
    if (candidate !== next[key]) {
      next = { ...next, [key]: candidate };
    }
  };
  if (typeof value.primary === "string") {
    assign("primary", normalizeAgentModelRefForConfig(value.primary));
  }
  if (Array.isArray(value.fallbacks)) {
    const originalFallbacks = value.fallbacks;
    const fallbacks = originalFallbacks.map((fallback) =>
      typeof fallback === "string" ? normalizeAgentModelRefForConfig(fallback) : fallback,
    );
    if (fallbacks.some((fallback, index) => fallback !== originalFallbacks[index])) {
      assign("fallbacks", fallbacks);
    }
  }
  return next;
}

function mergeAgentModelEntryForConfig(existing: unknown, incoming: unknown): unknown {
  if (!isPlainRecord(existing) || !isPlainRecord(incoming)) {
    return incoming;
  }

  const existingParams = isPlainRecord(existing.params) ? existing.params : undefined;
  const incomingParams = isPlainRecord(incoming.params) ? incoming.params : undefined;
  return {
    ...existing,
    ...incoming,
    ...(existingParams || incomingParams
      ? { params: { ...existingParams, ...incomingParams } }
      : undefined),
  };
}

/** Normalizes model map keys and merges entries that collapse to the same canonical ref. */
export function normalizeAgentModelMapForConfig<T extends Record<string, unknown>>(models: T): T {
  let mutated = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(models)) {
    const normalizedKey = normalizeAgentModelRefForConfig(key);
    if (normalizedKey !== key || Object.hasOwn(next, normalizedKey)) {
      mutated = true;
    }
    // Later entries win, but nested params merge so provider defaults are not discarded.
    next[normalizedKey] = mergeAgentModelEntryForConfig(next[normalizedKey], entry);
  }
  return (mutated ? next : models) as T;
}
