import {
  GPT5_BEHAVIOR_CONTRACT,
  GPT5_FRIENDLY_PROMPT_OVERLAY,
  isGpt5ModelId,
  renderGpt5PromptOverlay,
  resolveGpt5SystemPromptContribution,
} from "openclaw/plugin-sdk/provider-model-shared";

export const CODEX_FRIENDLY_PROMPT_OVERLAY = GPT5_FRIENDLY_PROMPT_OVERLAY;
export const CODEX_GPT5_BEHAVIOR_CONTRACT = GPT5_BEHAVIOR_CONTRACT;

export function shouldApplyCodexPromptOverlay(params: { modelId?: string }): boolean {
  return isGpt5ModelId(params.modelId);
}

export function resolveCodexSystemPromptContribution(
  params: Parameters<typeof resolveGpt5SystemPromptContribution>[0],
) {
  return resolveGpt5SystemPromptContribution(params);
}

export function renderCodexPromptOverlay(
  params: Parameters<typeof renderGpt5PromptOverlay>[0],
): string | undefined {
  return renderGpt5PromptOverlay(params);
}
