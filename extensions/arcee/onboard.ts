/**
 * Arcee setup preset appliers. They seed model catalog defaults for direct
 * Arcee API usage and the OpenRouter-backed path.
 */
import {
  applyProviderConfigWithModelCatalogPreset,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { ARCEE_BASE_URL } from "./models.js";
import {
  buildArceeCatalogModels,
  buildArceeOpenRouterCatalogModels,
  OPENROUTER_BASE_URL,
} from "./provider-catalog.js";

/** Default Arcee model ref for direct API setup. */
export const ARCEE_DEFAULT_MODEL_REF = "arcee/trinity-large-thinking";
/** Default Arcee model ref for OpenRouter setup. */
export const ARCEE_OPENROUTER_DEFAULT_MODEL_REF = "arcee/trinity-large-thinking";

const ARCEE_PRESET = {
  primaryModelRef: ARCEE_DEFAULT_MODEL_REF,
  providerId: "arcee",
  api: "openai-completions" as const,
  baseUrl: ARCEE_BASE_URL,
  aliases: [{ modelRef: ARCEE_DEFAULT_MODEL_REF, alias: "Arcee AI" }],
};

const ARCEE_OPENROUTER_PRESET = {
  primaryModelRef: ARCEE_OPENROUTER_DEFAULT_MODEL_REF,
  providerId: "arcee",
  api: "openai-completions" as const,
  baseUrl: OPENROUTER_BASE_URL,
  aliases: [{ modelRef: ARCEE_OPENROUTER_DEFAULT_MODEL_REF, alias: "Arcee AI (OpenRouter)" }],
};

/** Apply direct Arcee provider defaults to config. */
export function applyArceeConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyProviderConfigWithModelCatalogPreset(cfg, {
    ...ARCEE_PRESET,
    catalogModels: buildArceeCatalogModels(),
  });
}

/** Apply OpenRouter-backed Arcee provider defaults to config. */
export function applyArceeOpenRouterConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyProviderConfigWithModelCatalogPreset(cfg, {
    ...ARCEE_OPENROUTER_PRESET,
    catalogModels: buildArceeOpenRouterCatalogModels(),
  });
}

export function applyArceeOnboardConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyProviderConfigWithModelCatalogPreset(cfg, {
    ...ARCEE_PRESET,
    catalogModels: cfg.models?.mode === "replace" ? buildArceeCatalogModels() : [],
  });
}

export function applyArceeOpenRouterOnboardConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyProviderConfigWithModelCatalogPreset(cfg, {
    ...ARCEE_OPENROUTER_PRESET,
    catalogModels: cfg.models?.mode === "replace" ? buildArceeOpenRouterCatalogModels() : [],
  });
}
