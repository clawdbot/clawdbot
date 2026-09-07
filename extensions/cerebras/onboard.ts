import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import { createModelCatalogPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { buildCerebrasCatalogModels, CEREBRAS_BASE_URL } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const CEREBRAS_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(
  manifest,
  "cerebras",
)!;

export const { applyConfig: applyCerebrasConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: CEREBRAS_DEFAULT_MODEL_REF,
  resolveParams: (cfg) => ({
    providerId: "cerebras",
    api: "openai-completions",
    baseUrl: CEREBRAS_BASE_URL,
    // Replace mode skips discovery; merge mode must not persist generated pricing as authored pins.
    catalogModels: cfg.models?.mode === "replace" ? buildCerebrasCatalogModels() : [],
    aliases: [{ modelRef: CEREBRAS_DEFAULT_MODEL_REF, alias: "Cerebras Gemma 4 31B" }],
  }),
});
