import { createDefaultModelsPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import {
  buildFireworksCatalogModels,
  buildFireworksProvider,
  FIREWORKS_DEFAULT_MODEL_ID,
  FIREWORKS_DEFAULT_MODEL_REF,
} from "./provider-catalog.js";

export const { applyConfig: applyFireworksConfig } = createDefaultModelsPresetAppliers<[]>({
  primaryModelRef: FIREWORKS_DEFAULT_MODEL_REF,
  resolveParams: (cfg) => {
    const defaultProvider = buildFireworksProvider();
    return {
      providerId: "fireworks",
      api: defaultProvider.api ?? "openai-completions",
      baseUrl: defaultProvider.baseUrl,
      defaultModels: cfg.models?.mode === "replace" ? buildFireworksCatalogModels() : [],
      defaultModelId: FIREWORKS_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: FIREWORKS_DEFAULT_MODEL_REF, alias: "GLM 5.2 Fast" }],
    };
  },
});
