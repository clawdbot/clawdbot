// Google provider module implements model/runtime integration.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/core";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeAntigravityModelId, normalizeGoogleModelId } from "./model-id.js";
import {
  isGoogleGenerativeAiApi,
  isGoogleVertexBaseUrl,
  normalizeGoogleApiBaseUrl,
  normalizeGoogleGenerativeAiBaseUrl,
} from "./src/google-api-base-url.js";
import { isGoogleGemini3ProModel, isGoogleGemini3ThinkingLevelModel } from "./thinking-api.js";

export {
  DEFAULT_GOOGLE_API_BASE_URL,
  isGoogleGenerativeAiApi,
  isGoogleVertexBaseUrl,
  isGoogleVertexHostname,
  normalizeGoogleApiBaseUrl,
  normalizeGoogleGenerativeAiBaseUrl,
} from "./src/google-api-base-url.js";

type GoogleApiCarrier = {
  api?: string | null;
};

type GoogleProviderConfigLike = GoogleApiCarrier & {
  baseUrl?: string | null;
  models?: ReadonlyArray<GoogleApiCarrier | null | undefined> | null;
};

const GOOGLE_MODEL_ID_PROVIDERS = new Set(["google", "google-gemini-cli", "google-vertex"]);

export function resolveGoogleGenerativeAiTransport<TApi extends string | null | undefined>(params: {
  provider?: string;
  api: TApi;
  baseUrl?: string;
}): { api: TApi | "google-generative-ai" | "google-vertex"; baseUrl?: string } {
  const api =
    params.api ??
    (params.provider === "google-vertex" && isGoogleVertexBaseUrl(params.baseUrl)
      ? "google-vertex"
      : undefined) ??
    (params.provider === "google" && params.baseUrl ? "google-generative-ai" : params.api);
  return {
    api,
    baseUrl: isGoogleGenerativeAiApi(api)
      ? normalizeGoogleGenerativeAiBaseUrl(params.baseUrl)
      : params.baseUrl,
  };
}

export function resolveGoogleGenerativeAiApiOrigin(baseUrl?: string): string {
  return (
    normalizeGoogleGenerativeAiBaseUrl(baseUrl) ?? normalizeGoogleApiBaseUrl(baseUrl)
  ).replace(/\/v1beta$/i, "");
}

export function shouldNormalizeGoogleGenerativeAiProviderConfig(
  providerKey: string,
  provider: GoogleProviderConfigLike,
): boolean {
  if (providerKey === "google-vertex" && isGoogleVertexBaseUrl(provider.baseUrl)) {
    return false;
  }
  if (isGoogleGenerativeAiApi(provider.api)) {
    return true;
  }
  const hasGoogleGenerativeAiModelApi =
    provider.models?.some((model) => isGoogleGenerativeAiApi(model?.api)) ?? false;
  if (hasGoogleGenerativeAiModelApi) {
    return true;
  }
  if (providerKey !== "google" && providerKey !== "google-vertex") {
    return false;
  }
  const hasExplicitNonGoogleApi = normalizeOptionalString(provider.api) !== undefined;
  return !hasExplicitNonGoogleApi;
}

export function shouldNormalizeGoogleProviderConfig(
  providerKey: string,
  provider: GoogleProviderConfigLike,
): boolean {
  return (
    providerKey === "google-antigravity" ||
    shouldNormalizeGoogleGenerativeAiProviderConfig(providerKey, provider)
  );
}

function normalizeProviderModels(
  provider: ModelProviderConfig,
  normalizeId: (id: string) => string,
): ModelProviderConfig {
  const models = provider.models;
  if (!Array.isArray(models) || models.length === 0) {
    return provider;
  }

  let mutated = false;
  const nextModels = models.map((model) => {
    const nextId = normalizeId(model.id);
    if (nextId === model.id) {
      return model;
    }
    mutated = true;
    return Object.assign({}, model, { id: nextId });
  });

  return mutated ? { ...provider, models: nextModels } : provider;
}

export function normalizeGoogleProviderConfig(
  providerKey: string,
  provider: ModelProviderConfig,
): ModelProviderConfig {
  let nextProvider = provider;
  const shouldNormalizeModelIds = GOOGLE_MODEL_ID_PROVIDERS.has(providerKey);

  if (shouldNormalizeModelIds) {
    const modelNormalized = normalizeProviderModels(nextProvider, normalizeGoogleModelId);
    if (shouldNormalizeGoogleGenerativeAiProviderConfig(providerKey, modelNormalized)) {
      const normalizedBaseUrl = normalizeGoogleGenerativeAiBaseUrl(modelNormalized.baseUrl);
      nextProvider =
        normalizedBaseUrl !== modelNormalized.baseUrl
          ? { ...modelNormalized, baseUrl: normalizedBaseUrl ?? modelNormalized.baseUrl }
          : modelNormalized;
    } else {
      nextProvider = modelNormalized;
    }
  }

  if (providerKey === "google-antigravity") {
    nextProvider = normalizeProviderModels(nextProvider, normalizeAntigravityModelId);
  }

  return nextProvider;
}

export function resolveGoogleThinkingProfile({
  modelId,
  reasoning,
}: ProviderDefaultThinkingPolicyContext): ProviderThinkingProfile | undefined {
  const normalizedModelId = normalizeGoogleModelId(modelId);
  const isGemini3ThinkingModel = isGoogleGemini3ThinkingLevelModel(normalizedModelId);
  if (reasoning === false && !isGemini3ThinkingModel) {
    return undefined;
  }

  const levels: ProviderThinkingProfile["levels"] = isGoogleGemini3ProModel(normalizedModelId)
    ? [{ id: "off" }, { id: "low" }, { id: "adaptive" }, { id: "high" }]
    : [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "adaptive" },
        { id: "high" },
      ];

  return {
    levels,
    ...(isGemini3ThinkingModel ? { preserveWhenCatalogReasoningFalse: true } : {}),
  };
}
