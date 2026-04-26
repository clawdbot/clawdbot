import {
  applyProviderConfigWithDefaultModelPreset,
  type ModelDefinitionConfig,
  type OpenClawConfig,
} from "../../src/plugin-sdk/provider-onboard.ts";

export type { OpenClawConfig };

const DOCKER_OPENAI_MODEL_REF = "openai/gpt-5.5";
const DOCKER_OPENAI_BASE_URL =
  process.env.OPENCLAW_DOCKER_OPENAI_BASE_URL?.trim() || "http://127.0.0.1:9/v1";
const DOCKER_OPENAI_MODEL: ModelDefinitionConfig = {
  id: "gpt-5.5",
  name: "gpt-5.5",
  api: "openai-responses",
  reasoning: true,
  input: ["text", "image"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 1_050_000,
  maxTokens: 128_000,
};

export function applyDockerOpenAiProviderConfig(
  config: OpenClawConfig,
  apiKey: string,
): OpenClawConfig {
  const seededConfig = applyProviderConfigWithDefaultModelPreset(config, {
    providerId: "openai",
    api: "openai-responses",
    baseUrl: DOCKER_OPENAI_BASE_URL,
    defaultModel: DOCKER_OPENAI_MODEL,
    defaultModelId: DOCKER_OPENAI_MODEL.id,
    aliases: [{ modelRef: DOCKER_OPENAI_MODEL_REF, alias: "GPT" }],
    primaryModelRef: DOCKER_OPENAI_MODEL_REF,
  });
  const openAiProvider = seededConfig.models?.providers?.openai;
  if (!openAiProvider) {
    throw new Error("failed to seed OpenAI provider config");
  }
  openAiProvider.apiKey = apiKey;
  return seededConfig;
}
