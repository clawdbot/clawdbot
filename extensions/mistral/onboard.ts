import {
  createDefaultModelPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildMistralModelDefinition,
  MISTRAL_BASE_URL,
  MISTRAL_DEFAULT_MODEL_ID,
  MISTRAL_DEFAULT_MODEL_REF,
} from "./model-definitions.js";

const mistralPresetAppliers = createDefaultModelPresetAppliers({
  primaryModelRef: MISTRAL_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "mistral",
    api: "openai-completions",
    baseUrl: MISTRAL_BASE_URL,
    defaultModel: buildMistralModelDefinition(),
    defaultModelId: MISTRAL_DEFAULT_MODEL_ID,
    aliases: [{ modelRef: MISTRAL_DEFAULT_MODEL_REF, alias: "Mistral" }],
  }),
});

export function applyMistralProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return mistralPresetAppliers.applyProviderConfig(cfg);
}

export function applyMistralConfig(cfg: OpenClawConfig): OpenClawConfig {
  return mistralPresetAppliers.applyConfig(cfg);
}
