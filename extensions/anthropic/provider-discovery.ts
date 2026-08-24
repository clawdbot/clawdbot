/**
 * Claude CLI provider discovery descriptor. It exposes subscription-backed
 * synthetic auth for catalog/runtime discovery without full Anthropic registration.
 */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { readClaudeCliCredentialsForRuntime } from "./cli-auth-seam.js";
import { CLAUDE_CLI_API_KEY_HELPER_AUTH_MARKER } from "./cli-constants.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

export function resolveClaudeCliSyntheticAuth() {
  const credential = readClaudeCliCredentialsForRuntime();
  if (!credential) {
    return undefined;
  }
  switch (credential.type) {
    case "oauth":
      return {
        apiKey: credential.access,
        source: "Claude CLI native auth",
        mode: "oauth" as const,
        expiresAt: credential.expires,
      };
    case "token":
      return {
        apiKey: credential.token,
        source: "Claude CLI native auth",
        mode: "token" as const,
        expiresAt: credential.expires,
      };
    case "api_key_helper": {
      const marker = CLAUDE_CLI_API_KEY_HELPER_AUTH_MARKER;
      return {
        apiKey: marker,
        source: "Claude CLI apiKeyHelper",
        mode: "api-key" as const,
      };
    }
  }
  return undefined;
}

const anthropicProviderDiscovery: ProviderPlugin = {
  id: CLAUDE_CLI_BACKEND_ID,
  label: "Claude CLI",
  docsPath: "/providers/models",
  auth: [],
  resolveSyntheticAuth: ({ provider }) =>
    provider === CLAUDE_CLI_BACKEND_ID ? resolveClaudeCliSyntheticAuth() : undefined,
};

export default anthropicProviderDiscovery;
