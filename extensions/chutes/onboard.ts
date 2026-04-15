import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalogPreset,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  CHUTES_BASE_URL,
  CHUTES_DEFAULT_MODEL_REF,
  CHUTES_MODEL_CATALOG,
  buildChutesModelDefinition,
} from "./models.js";

export { CHUTES_DEFAULT_MODEL_REF };

/**
 * Apply Chutes provider configuration without changing the default model.
 * Registers all catalog models and sets provider aliases (chutes-fast, etc.).
 */
export function applyChutesProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyProviderConfigWithModelCatalogPreset(cfg, {
    providerId: "chutes",
    api: "openai-completions",
    baseUrl: CHUTES_BASE_URL,
    catalogModels: CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition),
    aliases: [
      ...CHUTES_MODEL_CATALOG.map((model) => `chutes/${model.id}`),
      { modelRef: "chutes-fast", alias: "chutes/zai-org/GLM-4.7-FP8" },
      {
        modelRef: "chutes-vision",
        alias: "chutes/chutesai/Mistral-Small-3.2-24B-Instruct-2506",
      },
      { modelRef: "chutes-pro", alias: "chutes/deepseek-ai/DeepSeek-V3.2-TEE" },
    ],
  });
}

/**
 * Apply Chutes provider configuration AND set Chutes as the default model.
 */
export function applyChutesConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyChutesProviderConfig(cfg);
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          primary: CHUTES_DEFAULT_MODEL_REF,
          fallbacks: ["chutes/deepseek-ai/DeepSeek-V3.2-TEE", "chutes/Qwen/Qwen3-32B"],
        },
        imageModel: {
          primary: "chutes/chutesai/Mistral-Small-3.2-24B-Instruct-2506",
          fallbacks: ["chutes/chutesai/Mistral-Small-3.1-24B-Instruct-2503"],
        },
      },
    },
  };
}

export function applyChutesApiKeyConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyChutesProviderConfig(cfg), CHUTES_DEFAULT_MODEL_REF);
}
