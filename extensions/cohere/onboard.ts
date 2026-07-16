import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildCohereModelDefinition,
  COHERE_BASE_URL,
  COHERE_COMMAND_A_PLUS_MODEL_ID,
  COHERE_MODEL_CATALOG,
} from "./models.js";

const COHERE_DEFAULT_MODEL_ID = COHERE_COMMAND_A_PLUS_MODEL_ID;
export const COHERE_DEFAULT_MODEL_REF = `cohere/${COHERE_DEFAULT_MODEL_ID}`;

const coherePresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: COHERE_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "cohere",
    api: "openai-completions",
    baseUrl: COHERE_BASE_URL,
    catalogModels: COHERE_MODEL_CATALOG.map(buildCohereModelDefinition),
    aliases: [{ modelRef: COHERE_DEFAULT_MODEL_REF, alias: "Cohere Command A+" }],
  }),
});

export function applyCohereConfig(cfg: OpenClawConfig): OpenClawConfig {
  return coherePresetAppliers.applyConfig(cfg);
}
