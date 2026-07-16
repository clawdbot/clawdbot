import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { discoverVercelAiGatewayModels, VERCEL_AI_GATEWAY_BASE_URL } from "./models.js";

export async function buildVercelAiGatewayProvider(): Promise<ModelProviderConfig> {
  return {
    baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
    api: "anthropic-messages",
    models: await discoverVercelAiGatewayModels(),
  };
}
