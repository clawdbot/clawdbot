import { normalizeProviderId } from "../agents/provider-id.js";
import { normalizeGooglePreviewModelId } from "../plugin-sdk/provider-model-id-normalize.js";
import { isRecord as isPlainRecord } from "../shared/record-coerce.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "../shared/string-coerce.js";
import type { AgentModelConfig, AgentToolModelConfig } from "./types.agents-shared.js";

type AgentModelListLike = {
  primary?: string;
  fallbacks?: string[];
};

function modelKeyForConfig(provider: string, model: string): string {
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

type AgentModelInput = AgentModelConfig | AgentToolModelConfig;

export function resolveAgentModelPrimaryValue(model?: AgentModelInput): string | undefined {
  return resolvePrimaryStringValue(model);
}

export function resolveAgentModelFallbackValues(model?: AgentModelInput): string[] {
  if (!model || typeof model !== "object") {
    return [];
  }
  return Array.isArray(model.fallbacks) ? model.fallbacks : [];
}

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

export function normalizeAgentModelRefForConfig(model: string): string {
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return trimmed;
  }

  const provider = normalizeProviderId(trimmed.slice(0, slash));
  const modelSuffix = trimmed.slice(slash + 1);
  const normalizedModel =
    GOOGLE_PROVIDER_IDS.has(provider) || modelSuffix.startsWith("google/")
      ? normalizeGooglePreviewModelId(modelSuffix)
      : modelSuffix;
  return modelKeyForConfig(provider, normalizedModel);
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

export function normalizeAgentModelMapForConfig<T extends Record<string, unknown>>(models: T): T {
  let mutated = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(models)) {
    const normalizedKey = normalizeAgentModelRefForConfig(key);
    if (normalizedKey !== key || Object.prototype.hasOwnProperty.call(next, normalizedKey)) {
      mutated = true;
    }
    next[normalizedKey] = mergeAgentModelEntryForConfig(next[normalizedKey], entry);
  }
  return (mutated ? next : models) as T;
}
