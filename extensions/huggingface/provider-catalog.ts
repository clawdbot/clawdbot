import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { discoverHuggingfaceModels, HUGGINGFACE_BASE_URL } from "./models.js";

export async function buildHuggingfaceProvider(discoveryApiKey = ""): Promise<ModelProviderConfig> {
  return {
    baseUrl: HUGGINGFACE_BASE_URL,
    api: "openai-completions",
    models: await discoverHuggingfaceModels(discoveryApiKey),
  };
}
