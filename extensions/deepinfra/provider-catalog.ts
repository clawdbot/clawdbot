import { type ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_MODEL_CATALOG,
  buildDeepInfraModelDefinition,
  discoverDeepInfraModels,
} from "./provider-models.js";

export function buildStaticDeepInfraProvider(): ModelProviderConfig {
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models: DEEPINFRA_MODEL_CATALOG.map(buildDeepInfraModelDefinition),
  };
}

export async function buildDeepInfraProvider(): Promise<ModelProviderConfig> {
  const models = await discoverDeepInfraModels();
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models,
  };
}
