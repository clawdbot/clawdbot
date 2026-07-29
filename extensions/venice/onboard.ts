// Venice setup module handles plugin onboarding behavior.
import { createModelCatalogPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { VENICE_BASE_URL, VENICE_DEFAULT_MODEL_REF, VENICE_MODEL_CATALOG } from "./api.js";

export const { applyConfig: applyVeniceConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: VENICE_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "venice",
    api: "openai-completions",
    baseUrl: VENICE_BASE_URL,
    catalogModels: structuredClone(VENICE_MODEL_CATALOG),
    aliases: [{ modelRef: VENICE_DEFAULT_MODEL_REF, alias: "GLM 4.7" }],
  }),
});
