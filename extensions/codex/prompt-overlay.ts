import {
  GPT5_BEHAVIOR_CONTRACT,
  GPT5_HEARTBEAT_PROMPT_OVERLAY,
  renderGpt5PromptOverlay,
  resolveGpt5SystemPromptContribution,
} from "openclaw/plugin-sdk/provider-model-shared";

export const CODEX_GPT5_BEHAVIOR_CONTRACT = GPT5_BEHAVIOR_CONTRACT;
export const CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY = GPT5_HEARTBEAT_PROMPT_OVERLAY;

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
