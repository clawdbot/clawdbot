/**
 * Builds GitHub Copilot provider compatibility headers from message content.
 */
import { projectCopilotRequestFacts } from "@openclaw/ai/internal/shared";
import type { Context } from "../llm/types.js";

/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export const COPILOT_EDITOR_VERSION = "vscode/1.107.0";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export const COPILOT_USER_AGENT = "GitHubCopilotChat/0.35.0";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export const COPILOT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export const COPILOT_GITHUB_API_VERSION = "2025-04-01";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export const COPILOT_INTEGRATION_ID = "vscode-chat";

/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export function buildCopilotIdeHeaders(
  params: {
    includeApiVersion?: boolean;
  } = {},
): Record<string, string> {
  return {
    "Accept-Encoding": "identity",
    "Editor-Version": COPILOT_EDITOR_VERSION,
    "Editor-Plugin-Version": COPILOT_EDITOR_PLUGIN_VERSION,
    "User-Agent": COPILOT_USER_AGENT,
    ...(params.includeApiVersion ? { "X-Github-Api-Version": COPILOT_GITHUB_API_VERSION } : {}),
  };
}

/** Return true when Copilot should receive its vision request header. */
export function hasCopilotVisionInput(messages: Context["messages"]): boolean {
  return projectCopilotRequestFacts(messages, "nested").hasImages;
}

/** Build per-request Copilot headers, including initiator and vision flags. */
export function buildCopilotDynamicHeaders(params: {
  messages: Context["messages"];
  hasImages: boolean;
}): Record<string, string> {
  return {
    "x-initiator": projectCopilotRequestFacts(params.messages, "nested", params.hasImages)
      .initiator,
    ...(params.hasImages ? { "Copilot-Vision-Request": "true" } : {}),
  };
}
