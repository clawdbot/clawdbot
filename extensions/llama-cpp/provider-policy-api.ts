import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  MANAGED_LLAMA_CPP_CONFIG_REQUIRED_MESSAGE,
  resolveManagedLlamaCppProviderConfig,
} from "./src/managed-provider-config.js";

export function inspectEmbeddingProviderSetup(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentId: string;
  provider: string;
}): {
  provider: string;
  reason: string;
  requirement: string;
  fixHint: string;
} | null {
  if (params.provider !== "local") {
    return null;
  }
  const fixHint =
    `Run \`openclaw models --agent ${params.agentId} auth login --provider llama-cpp --method local\` ` +
    "in an interactive terminal, then rerun this check.";
  try {
    resolveManagedLlamaCppProviderConfig(params.config);
  } catch {
    return {
      provider: params.provider,
      reason: MANAGED_LLAMA_CPP_CONFIG_REQUIRED_MESSAGE,
      requirement: "managed-llama-cpp-setup",
      fixHint,
    };
  }
  return null;
}
