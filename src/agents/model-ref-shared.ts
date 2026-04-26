import {
  normalizeGooglePreviewModelId,
  normalizeNativeXaiModelId,
} from "../plugin-sdk/provider-model-id-normalize.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeProviderId } from "./provider-id.js";

export type StaticModelRef = {
  provider: string;
  model: string;
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

export function normalizeAnthropicModelId(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return trimmed;
  }
  switch (normalizeLowercaseStringOrEmpty(trimmed)) {
    case "opus-4.6":
      return "claude-opus-4-6";
    case "opus-4.5":
      return "claude-opus-4-5";
    case "sonnet-4.6":
      return "claude-sonnet-4-6";
    case "sonnet-4.5":
      return "claude-sonnet-4-5";
    default:
      return trimmed;
  }
}

function normalizeHuggingfaceModelId(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return trimmed;
  }
  const prefix = "huggingface/";
  return normalizeLowercaseStringOrEmpty(trimmed).startsWith(prefix)
    ? trimmed.slice(prefix.length)
    : trimmed;
}

export function normalizeStaticProviderModelId(provider: string, model: string): string {
  if (provider === "anthropic") {
    return normalizeAnthropicModelId(model);
  }
  if (provider === "huggingface") {
    return normalizeHuggingfaceModelId(model);
  }
  if (provider === "google" || provider === "google-vertex") {
    return normalizeGooglePreviewModelId(model);
  }
  if (provider === "openrouter" && !model.includes("/")) {
    return `openrouter/${model}`;
  }
  if (provider === "nvidia" && !model.includes("/")) {
    return `nvidia/${model}`;
  }
  if (provider === "xai") {
    return normalizeNativeXaiModelId(model);
  }
  if (provider === "vercel-ai-gateway" && !model.includes("/")) {
    const normalizedAnthropicModel = normalizeAnthropicModelId(model);
    if (normalizedAnthropicModel.startsWith("claude-")) {
      return `anthropic/${normalizedAnthropicModel}`;
    }
  }
  return model;
}

export function parseStaticModelRef(raw: string, defaultProvider: string): StaticModelRef | null {
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
