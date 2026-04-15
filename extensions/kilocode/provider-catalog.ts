import { type ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  discoverKilocodeModels,
  KILOCODE_BASE_URL as LOCAL_KILOCODE_BASE_URL,
  KILOCODE_DEFAULT_CONTEXT_WINDOW as LOCAL_KILOCODE_DEFAULT_CONTEXT_WINDOW,
  KILOCODE_DEFAULT_COST as LOCAL_KILOCODE_DEFAULT_COST,
  KILOCODE_DEFAULT_MAX_TOKENS as LOCAL_KILOCODE_DEFAULT_MAX_TOKENS,
  KILOCODE_MODEL_CATALOG as LOCAL_KILOCODE_MODEL_CATALOG,
} from "./provider-models.js";

export function buildKilocodeProvider(): ModelProviderConfig {
  return {
    baseUrl: LOCAL_KILOCODE_BASE_URL,
    api: "openai-completions",
    models: LOCAL_KILOCODE_MODEL_CATALOG.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: LOCAL_KILOCODE_DEFAULT_COST,
      contextWindow: model.contextWindow ?? LOCAL_KILOCODE_DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? LOCAL_KILOCODE_DEFAULT_MAX_TOKENS,
    })),
  };
}

export async function buildKilocodeProviderWithDiscovery(): Promise<ModelProviderConfig> {
  const models = await discoverKilocodeModels();
  return {
    baseUrl: LOCAL_KILOCODE_BASE_URL,
    api: "openai-completions",
    models,
  };
}
