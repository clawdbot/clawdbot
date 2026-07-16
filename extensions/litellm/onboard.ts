import {
  createDefaultModelPresetAppliers,
  type ModelDefinitionConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const LITELLM_BASE_URL = "http://localhost:4000";
export const LITELLM_DEFAULT_MODEL_ID = "claude-opus-4-6";
export const LITELLM_DEFAULT_MODEL_REF = `litellm/${LITELLM_DEFAULT_MODEL_ID}`;
const LITELLM_DEFAULT_CONTEXT_WINDOW = 128_000;
const LITELLM_DEFAULT_MAX_TOKENS = 8_192;
const LITELLM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildLitellmModelDefinition(): ModelDefinitionConfig {
  return {
    id: LITELLM_DEFAULT_MODEL_ID,
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: LITELLM_DEFAULT_COST,
    contextWindow: LITELLM_DEFAULT_CONTEXT_WINDOW,
    maxTokens: LITELLM_DEFAULT_MAX_TOKENS,
  };
}

const litellmPresetAppliers = createDefaultModelPresetAppliers({
  primaryModelRef: LITELLM_DEFAULT_MODEL_REF,
  resolveParams: (cfg: OpenClawConfig) => {
    const existingProvider = cfg.models?.providers?.litellm as { baseUrl?: unknown } | undefined;
    const resolvedBaseUrl =
      typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";

    return {
      providerId: "litellm",
      api: "openai-completions" as const,
      baseUrl: resolvedBaseUrl || LITELLM_BASE_URL,
      defaultModel: buildLitellmModelDefinition(),
      defaultModelId: LITELLM_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: LITELLM_DEFAULT_MODEL_REF, alias: "LiteLLM" }],
    };
  },
});

export function applyLitellmProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return litellmPresetAppliers.applyProviderConfig(cfg);
}

export function applyLitellmConfig(cfg: OpenClawConfig): OpenClawConfig {
  return litellmPresetAppliers.applyConfig(cfg);
}
