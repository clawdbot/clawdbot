import { buildCopilotIdeHeaders } from "openclaw/plugin-sdk/provider-auth";

// GitHub's current fine-grained PAT contract is the Copilot CLI identity.
// Keep this provider-owned instead of changing the legacy public SDK constant.
export const COPILOT_RUNTIME_INTEGRATION_ID = "copilot-developer-cli";

/** Build the static request identity shared by Copilot inference transports. */
export function buildCopilotRuntimeHeaders(): Record<string, string> {
  return {
    ...buildCopilotIdeHeaders(),
    "Copilot-Integration-Id": COPILOT_RUNTIME_INTEGRATION_ID,
    "Openai-Organization": "github-copilot",
  };
}
