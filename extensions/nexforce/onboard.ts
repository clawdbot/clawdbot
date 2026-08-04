import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import { createModelCatalogPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { buildNexforceCatalogModels, NEXFORCE_BASE_URL } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const NEXFORCE_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(
  manifest,
  "nexforce",
)!;

export const { applyConfig: applyNexforceConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: NEXFORCE_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "nexforce",
    api: "openai-completions",
    baseUrl: NEXFORCE_BASE_URL,
    catalogModels: buildNexforceCatalogModels(),
    aliases: [{ modelRef: NEXFORCE_DEFAULT_MODEL_REF, alias: "Nexforce Smart Route" }],
  }),
});
