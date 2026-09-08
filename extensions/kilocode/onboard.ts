// Kilocode setup module handles plugin onboarding behavior.
import { createModelCatalogPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { buildKilocodeProvider } from "./provider-catalog.js";
import { KILOCODE_BASE_URL, KILOCODE_DEFAULT_MODEL_REF } from "./provider-models.js";

export { KILOCODE_DEFAULT_MODEL_REF };

export const { applyConfig: applyKilocodeConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: KILOCODE_DEFAULT_MODEL_REF,
  resolveParams: (cfg) => ({
    providerId: "kilocode",
    api: "openai-completions",
    baseUrl: KILOCODE_BASE_URL,
    catalogModels: cfg.models?.mode === "replace" ? buildKilocodeProvider().models : [],
    aliases: [{ modelRef: KILOCODE_DEFAULT_MODEL_REF, alias: "Kilo Gateway" }],
  }),
});
