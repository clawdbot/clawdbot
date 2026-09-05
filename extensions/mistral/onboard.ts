import { createDefaultModelPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import {
  buildMistralModelDefinition,
  MISTRAL_BASE_URL,
  MISTRAL_DEFAULT_MODEL_ID,
  MISTRAL_DEFAULT_MODEL_REF,
} from "./model-definitions.js";

export const { applyConfig: applyMistralConfig, applyProviderConfig: applyMistralProviderConfig } =
  createDefaultModelPresetAppliers<[]>({
    primaryModelRef: MISTRAL_DEFAULT_MODEL_REF,
    resolveParams: () => ({
      providerId: "mistral",
      api: "openai-completions",
      baseUrl: MISTRAL_BASE_URL,
      defaultModel: buildMistralModelDefinition(),
      defaultModelId: MISTRAL_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: MISTRAL_DEFAULT_MODEL_REF, alias: "Mistral" }],
    }),
  });
