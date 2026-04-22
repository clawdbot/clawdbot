import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyVercelAiGatewayConfig, VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF } from "./onboard.js";
import {
  buildStaticVercelAiGatewayProvider,
  buildVercelAiGatewayProvider,
} from "./provider-catalog.js";

const PROVIDER_ID = "vercel-ai-gateway";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Vercel AI Gateway Provider",
  description: "Bundled Vercel AI Gateway provider plugin",
  provider: {
    label: "Vercel AI Gateway",
    docsPath: "/providers/vercel-ai-gateway",
    auth: [
      {
        methodId: "api-key",
        label: "Vercel AI Gateway API key",
        hint: "API key",
        optionKey: "aiGatewayApiKey",
        flagName: "--ai-gateway-api-key",
        envVar: "AI_GATEWAY_API_KEY",
        promptMessage: "Enter Vercel AI Gateway API key",
        defaultModel: VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyVercelAiGatewayConfig(cfg),
        wizard: {
          choiceId: "ai-gateway-api-key",
          groupId: "ai-gateway",
        },
      },
    ],
    catalog: {
      buildProvider: buildVercelAiGatewayProvider,
      buildStaticProvider: buildStaticVercelAiGatewayProvider,
    },
  },
});
