/**
 * Claude CLI provider discovery descriptor. It exposes subscription-backed
 * synthetic auth for catalog/runtime discovery without full Anthropic registration.
 */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { probeClaudeCliAuthStatus } from "./cli-auth-seam.js";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_NATIVE_AUTH_MARKER } from "./cli-constants.js";

const nativeLoginAvailabilityByConfig = new WeakMap<object, boolean>();

export function resolveClaudeCliSyntheticAuth(config: object | undefined) {
  if (!config) {
    return undefined;
  }
  let available = nativeLoginAvailabilityByConfig.get(config);
  if (available === undefined) {
    available = probeClaudeCliAuthStatus().status === "available";
    nativeLoginAvailabilityByConfig.set(config, available);
  }
  if (!available) {
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
  resolveSyntheticAuth: ({ config, provider }) =>
    provider === CLAUDE_CLI_BACKEND_ID ? resolveClaudeCliSyntheticAuth(config) : undefined,
};

export default anthropicProviderDiscovery;
