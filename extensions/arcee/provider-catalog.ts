import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildArceeModelDefinition, ARCEE_BASE_URL, ARCEE_MODEL_CATALOG } from "./models.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_LEGACY_BASE_URL = "https://openrouter.ai/v1";

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

export function normalizeArceeOpenRouterBaseUrl(baseUrl: string | undefined): string | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return undefined;
  }
  if (normalized === OPENROUTER_BASE_URL || normalized === OPENROUTER_LEGACY_BASE_URL) {
    return OPENROUTER_BASE_URL;
  }
  return undefined;
}

export function isArceeOpenRouterBaseUrl(baseUrl: string | undefined): boolean {
  return normalizeArceeOpenRouterBaseUrl(baseUrl) === OPENROUTER_BASE_URL;
}

export function toArceeOpenRouterModelId(modelId: string): string {
  const normalized = modelId.trim();
  if (!normalized || normalized.startsWith("arcee/")) {
    return normalized;
  }
  return `arcee/${normalized}`;
}

export function buildArceeCatalogModels(): NonNullable<ModelProviderConfig["models"]> {
  return ARCEE_MODEL_CATALOG.map(buildArceeModelDefinition);
}

export function buildArceeOpenRouterCatalogModels(): NonNullable<ModelProviderConfig["models"]> {
  return buildArceeCatalogModels().map((model) =>
    Object.assign({}, model, { id: toArceeOpenRouterModelId(model.id) }),
  );
}

export function buildArceeProvider(): ModelProviderConfig {
  return {
    baseUrl: ARCEE_BASE_URL,
    api: "openai-completions",
    models: buildArceeCatalogModels(),
  };
}

export function buildArceeOpenRouterProvider(): ModelProviderConfig {
  return {
    baseUrl: OPENROUTER_BASE_URL,
    api: "openai-completions",
    models: buildArceeOpenRouterCatalogModels(),
  };
}
