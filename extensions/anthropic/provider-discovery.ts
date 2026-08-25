/**
 * Claude CLI provider discovery descriptor. It exposes subscription-backed
 * synthetic auth for catalog/runtime discovery without full Anthropic registration.
 */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { CLAUDE_CLI_NATIVE_AUTH_MARKER } from "./cli-constants.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

export function resolveClaudeCliSyntheticAuth() {
  return {
    apiKey: CLAUDE_CLI_NATIVE_AUTH_MARKER,
    source: "Claude CLI native auth",
    mode: "oauth" as const,
  };
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
