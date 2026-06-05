/**
 * Codex prompt-overlay facade for GPT-5 behavior and heartbeat guidance.
 */
import {
  GPT5_BEHAVIOR_CONTRACT,
  GPT5_HEARTBEAT_PROMPT_OVERLAY,
  renderGpt5PromptOverlay,
  resolveGpt5SystemPromptContribution,
} from "openclaw/plugin-sdk/provider-model-shared";

/** GPT-5 behavior contract re-exported under the Codex provider namespace. */
export const CODEX_GPT5_BEHAVIOR_CONTRACT = GPT5_BEHAVIOR_CONTRACT;
/** Heartbeat prompt overlay re-exported under the Codex provider namespace. */
export const CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY = GPT5_HEARTBEAT_PROMPT_OVERLAY;

/** Resolves the Codex system-prompt contribution for GPT-5-family models. */
export function resolveCodexSystemPromptContribution(
  params: Parameters<typeof resolveGpt5SystemPromptContribution>[0],
) {
  return resolveGpt5SystemPromptContribution(params);
}

/** Renders the Codex prompt overlay text for supported GPT-5-family models. */
export function renderCodexPromptOverlay(
  params: Parameters<typeof renderGpt5PromptOverlay>[0],
): string | undefined {
  return renderGpt5PromptOverlay(params);
}
