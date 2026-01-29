export {
  SYNTHETIC_DEFAULT_MODEL_ID,
  SYNTHETIC_DEFAULT_MODEL_REF,
} from "../agents/synthetic-models.js";
export { VENICE_DEFAULT_MODEL_ID, VENICE_DEFAULT_MODEL_REF } from "../agents/venice-models.js";
export {
  applyAuthProfileConfig,
  applyChutesConfig,
  applyChutesProviderConfig,
  applyKimiCodeConfig,
  applyKimiCodeProviderConfig,
  applyMoonshotConfig,
  applyMoonshotProviderConfig,
  applyOpenrouterConfig,
  applyOpenrouterProviderConfig,
  applySyntheticConfig,
  applySyntheticProviderConfig,
  applyVeniceConfig,
  applyVeniceProviderConfig,
  applyVercelAiGatewayConfig,
  applyVercelAiGatewayProviderConfig,
  applyZaiConfig,
} from "./onboard-auth.config-core.js";
export {
  applyMinimaxApiConfig,
  applyMinimaxApiProviderConfig,
  applyMinimaxConfig,
  applyMinimaxHostedConfig,
  applyMinimaxHostedProviderConfig,
  applyMinimaxProviderConfig,
} from "./onboard-auth.config-minimax.js";

export {
  applyOpencodeZenConfig,
  applyOpencodeZenProviderConfig,
} from "./onboard-auth.config-opencode.js";
export {
  OPENROUTER_DEFAULT_MODEL_REF,
  setAnthropicApiKey,
  setChutesApiKey,
  setGeminiApiKey,
  setKimiCodeApiKey,
  setMinimaxApiKey,
  setMoonshotApiKey,
  setOpencodeZenApiKey,
  setOpenrouterApiKey,
  setSyntheticApiKey,
  setVeniceApiKey,
  setVercelAiGatewayApiKey,
  setZaiApiKey,
  writeOAuthCredentials,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
  ZAI_DEFAULT_MODEL_REF,
} from "./onboard-auth.credentials.js";
export {
  buildChutesModelDefinition,
  buildKimiCodeModelDefinition,
  buildMinimaxApiModelDefinition,
  buildMinimaxModelDefinition,
  buildMoonshotModelDefinition,
  CHUTES_BASE_URL,
  CHUTES_DEFAULT_MODEL_ID,
  CHUTES_DEFAULT_MODEL_REF,
  DEFAULT_MINIMAX_BASE_URL,
  KIMI_CODE_BASE_URL,
  KIMI_CODE_MODEL_ID,
  KIMI_CODE_MODEL_REF,
  MINIMAX_API_BASE_URL,
  MINIMAX_HOSTED_MODEL_ID,
  MINIMAX_HOSTED_MODEL_REF,
  MOONSHOT_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "./onboard-auth.models.js";
