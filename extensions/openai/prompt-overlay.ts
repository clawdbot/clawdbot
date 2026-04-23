import {
  GPT5_BEHAVIOR_CONTRACT,
  GPT5_FRIENDLY_PROMPT_OVERLAY,
  isGpt5ModelId,
  resolveGpt5PromptOverlayMode,
  resolveGpt5SystemPromptContribution,
  type Gpt5PromptOverlayMode,
} from "openclaw/plugin-sdk/provider-model-shared";

const OPENAI_PROVIDER_IDS = new Set(["openai", "openai-codex"]);

export const OPENAI_FRIENDLY_PROMPT_OVERLAY = GPT5_FRIENDLY_PROMPT_OVERLAY;
export const OPENAI_GPT5_BEHAVIOR_CONTRACT = GPT5_BEHAVIOR_CONTRACT;

export type OpenAIPromptOverlayMode = Gpt5PromptOverlayMode;

export function resolveOpenAIPromptOverlayMode(
  pluginConfig?: Record<string, unknown>,
): OpenAIPromptOverlayMode {
  return resolveGpt5PromptOverlayMode(undefined, pluginConfig);
}

export function shouldApplyOpenAIPromptOverlay(params: {
  modelProviderId?: string;
  modelId?: string;
}): boolean {
  return OPENAI_PROVIDER_IDS.has(params.modelProviderId ?? "") && isGpt5ModelId(params.modelId);
}

export function resolveOpenAISystemPromptContribution(params: {
  config?: Parameters<typeof resolveGpt5SystemPromptContribution>[0]["config"];
  legacyPluginConfig?: Record<string, unknown>;
  mode?: OpenAIPromptOverlayMode;
  modelProviderId?: string;
  modelId?: string;
}) {
  return resolveGpt5SystemPromptContribution({
    config: params.config,
    legacyPluginConfig:
      params.mode === undefined ? params.legacyPluginConfig : { personality: params.mode },
    modelId: params.modelId,
    enabled: shouldApplyOpenAIPromptOverlay({
      modelProviderId: params.modelProviderId,
      modelId: params.modelId,
    }),
  });
}
