// Normalizes model input config into provider and model references.
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  normalizeGooglePreviewModelId,
  normalizeTogetherModelId,
} from "@openclaw/model-catalog-core/provider-model-id-normalize";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { modelKey } from "../shared/model-key.js";
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
  return modelKey(provider, normalizedModel);
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
