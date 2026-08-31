/** Baseten onboarding config helpers. */
import { createModelCatalogPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { BASETEN_BASE_URL, BASETEN_DEFAULT_MODEL_REF, buildStaticBasetenModels } from "./models.js";

/** Applies Baseten's provider catalog, Inkling alias, and default model. */
export const { applyConfig: applyBasetenConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: BASETEN_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "baseten",
    api: "openai-completions",
    baseUrl: BASETEN_BASE_URL,
    catalogModels: buildStaticBasetenModels(),
    aliases: [{ modelRef: BASETEN_DEFAULT_MODEL_REF, alias: "Inkling" }],
  }),
});
