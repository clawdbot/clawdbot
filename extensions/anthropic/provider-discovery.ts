import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { readClaudeCliCredentialsForRuntime } from "./cli-auth-seam.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

function resolveClaudeCliSyntheticAuth() {
  const credential = readClaudeCliCredentialsForRuntime();
  if (!credential) {
    return undefined;
  }
  return credential.type === "oauth"
    ? {
        apiKey: credential.access,
        source: "Claude CLI native auth",
        mode: "oauth" as const,
        expiresAt: credential.expires,
      }
    : {
        apiKey: credential.token,
        source: "Claude CLI native auth",
        mode: "token" as const,
        expiresAt: credential.expires,
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
