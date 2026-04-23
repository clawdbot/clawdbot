import {
  applyProviderConfigWithDefaultModelPreset,
  type ModelDefinitionConfig,
  type OpenClawConfig,
} from "../../src/plugin-sdk/provider-onboard.ts";

export type { OpenClawConfig };

const DOCKER_OPENAI_MODEL_REF = "openai/gpt-5.4";
const DOCKER_OPENAI_MODEL: ModelDefinitionConfig = {
  id: "gpt-5.4",
  name: "gpt-5.4",
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
    baseUrl: "http://127.0.0.1:9/v1",
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
