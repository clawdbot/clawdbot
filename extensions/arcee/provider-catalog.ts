/**
 * Arcee provider catalog builders. Direct Arcee uses native ids; OpenRouter
 * catalogs normalize ids to the `arcee/*` namespace.
 */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildArceeModelDefinition, ARCEE_BASE_URL, ARCEE_MODEL_CATALOG } from "./models.js";

/** Canonical OpenRouter API base URL for Arcee-routed models. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_LEGACY_BASE_URL = "https://openrouter.ai/v1";

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

/** Normalize OpenRouter base URLs accepted for Arcee model routing. */
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

/** Convert a bare Arcee model id to the OpenRouter `arcee/*` id. */
export function toArceeOpenRouterModelId(modelId: string): string {
  const normalized = modelId.trim();
  if (!normalized || normalized.startsWith("arcee/")) {
    return normalized;
  }
  return `arcee/${normalized}`;
}

/** Build direct Arcee catalog models. */
export function buildArceeCatalogModels(): NonNullable<ModelProviderConfig["models"]> {
  return ARCEE_MODEL_CATALOG.map(buildArceeModelDefinition);
}

/** Build OpenRouter-routed Arcee catalog models. */
export function buildArceeOpenRouterCatalogModels(): NonNullable<ModelProviderConfig["models"]> {
  return buildArceeCatalogModels().map((model) =>
    Object.assign({}, model, { id: toArceeOpenRouterModelId(model.id) }),
  );
}

/** Build the direct Arcee provider config. */
export function buildArceeProvider(): ModelProviderConfig {
  return {
    baseUrl: ARCEE_BASE_URL,
    api: "openai-completions",
    models: buildArceeCatalogModels(),
  };
}

/** Build the OpenRouter-backed Arcee provider config. */
export function buildArceeOpenRouterProvider(): ModelProviderConfig {
  return {
    baseUrl: OPENROUTER_BASE_URL,
    api: "openai-completions",
    models: buildArceeOpenRouterCatalogModels(),
  };
}
