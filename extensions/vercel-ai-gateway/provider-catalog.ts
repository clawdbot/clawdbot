import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  discoverVercelAiGatewayModels,
  getStaticVercelAiGatewayModelCatalog,
  VERCEL_AI_GATEWAY_BASE_URL,
} from "./models.js";

export function buildStaticVercelAiGatewayProvider(): ModelProviderConfig {
  return {
    baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
    api: "anthropic-messages",
    models: getStaticVercelAiGatewayModelCatalog(),
  };
}

export async function buildVercelAiGatewayProvider(): Promise<ModelProviderConfig> {
  return {
    baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
    api: "anthropic-messages",
    models: await discoverVercelAiGatewayModels(),
  };
}
