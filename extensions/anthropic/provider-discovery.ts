/**
 * Claude CLI provider discovery descriptor. It exposes subscription-backed
 * synthetic auth for catalog/runtime discovery without full Anthropic registration.
 */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { probeClaudeCliAuthStatus } from "./cli-auth-seam.js";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_NATIVE_AUTH_MARKER } from "./cli-constants.js";

export async function prepareClaudeCliSyntheticAuth(
  config: object | undefined,
  params?: { env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) {
  params?.signal?.throwIfAborted();
  if (!config) {
    return undefined;
  }
  if ((await probeClaudeCliAuthStatus(params)).status !== "available") {
    return undefined;
  }
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
  prepareSyntheticAuth: ({ config, provider, ...params }) =>
    prepareClaudeCliSyntheticAuth(provider === CLAUDE_CLI_BACKEND_ID ? config : undefined, params),
};

export default anthropicProviderDiscovery;
