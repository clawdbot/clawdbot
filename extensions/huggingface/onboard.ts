// Huggingface setup module handles plugin onboarding behavior.
import { createModelCatalogPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { HUGGINGFACE_BASE_URL, HUGGINGFACE_MODEL_CATALOG } from "./models.js";

export const HUGGINGFACE_DEFAULT_MODEL_REF = "huggingface/deepseek-ai/DeepSeek-R1";

export const { applyConfig: applyHuggingfaceConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: HUGGINGFACE_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "huggingface",
    api: "openai-completions",
    baseUrl: HUGGINGFACE_BASE_URL,
    catalogModels: HUGGINGFACE_MODEL_CATALOG.map((model) => Object.assign({}, model)),
    aliases: [{ modelRef: HUGGINGFACE_DEFAULT_MODEL_REF, alias: "Hugging Face" }],
  }),
});
