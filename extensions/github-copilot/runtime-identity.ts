import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildCopilotIdeHeaders } from "openclaw/plugin-sdk/provider-auth";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

// GitHub's current fine-grained PAT contract is the Copilot CLI identity.
// Keep this provider-owned instead of changing the legacy public SDK constant.
const COPILOT_RUNTIME_INTEGRATION_ID = "copilot-developer-cli";

/** Keep catalog and inference identity aligned without forwarding unrelated configured secrets. */
export function buildCopilotRuntimeHeaders(params?: {
  config?: OpenClawConfig;
  headers?: Record<string, string>;
}): Record<string, string> {
  const provider = params?.config?.models?.providers?.["github-copilot"];
  let integrationId = COPILOT_RUNTIME_INTEGRATION_ID;
  for (const headers of [provider?.headers, provider?.request?.headers, params?.headers]) {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (name.toLowerCase() === "copilot-integration-id") {
        integrationId =
          normalizeResolvedSecretInputString({
            value,
            path: "models.providers.github-copilot.headers.Copilot-Integration-Id",
          }) ?? integrationId;
      }
    }
  }
  // HTTP header names are case-insensitive. Remove every authored spelling so
  // native Headers/SDK merging cannot turn the identity into a comma-joined pair.
  const headers = Object.fromEntries(
    Object.entries(params?.headers ?? {}).filter(
      ([name]) => name.toLowerCase() !== "copilot-integration-id",
    ),
  );
  return {
    ...buildCopilotIdeHeaders(),
    "Openai-Organization": "github-copilot",
    ...headers,
    "Copilot-Integration-Id": integrationId,
  };
}
