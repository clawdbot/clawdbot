/**
 * Arcee setup preset appliers. They seed model catalog defaults for direct
 * Arcee API usage and the OpenRouter-backed path.
 */
import { createModelCatalogPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
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

/** Apply direct Arcee provider defaults to config. */
export const { applyConfig: applyArceeConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: ARCEE_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "arcee",
    api: "openai-completions",
    baseUrl: ARCEE_BASE_URL,
    catalogModels: buildArceeCatalogModels(),
    aliases: [{ modelRef: ARCEE_DEFAULT_MODEL_REF, alias: "Arcee AI" }],
  }),
});

/** Apply OpenRouter-backed Arcee provider defaults to config. */
export const { applyConfig: applyArceeOpenRouterConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: ARCEE_OPENROUTER_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "arcee",
    api: "openai-completions",
    baseUrl: OPENROUTER_BASE_URL,
    catalogModels: buildArceeOpenRouterCatalogModels(),
    aliases: [{ modelRef: ARCEE_OPENROUTER_DEFAULT_MODEL_REF, alias: "Arcee AI (OpenRouter)" }],
  }),
});
