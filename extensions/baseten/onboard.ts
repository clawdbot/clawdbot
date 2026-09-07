/** Baseten onboarding config helpers. */
import {
  createModelCatalogPresetAppliers,
  type ModelDefinitionConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { BASETEN_BASE_URL, BASETEN_DEFAULT_MODEL_REF, buildStaticBasetenModels } from "./models.js";

const { applyConfig } = createModelCatalogPresetAppliers<[ModelDefinitionConfig[]]>({
  primaryModelRef: BASETEN_DEFAULT_MODEL_REF,
  resolveParams: (_cfg, catalogModels) => ({
    providerId: "baseten",
    api: "openai-completions",
    baseUrl: BASETEN_BASE_URL,
    catalogModels,
    aliases: [{ modelRef: BASETEN_DEFAULT_MODEL_REF, alias: "Inkling" }],
  }),
});

/** Applies Baseten's provider catalog, Inkling alias, and default model. */
export const applyBasetenConfig = (cfg: OpenClawConfig) =>
  applyConfig(cfg, buildStaticBasetenModels());

export const applyBasetenSetupConfig = (cfg: OpenClawConfig) =>
  applyConfig(cfg, cfg.models?.mode === "replace" ? buildStaticBasetenModels() : []);
