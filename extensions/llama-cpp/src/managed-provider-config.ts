import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { LLAMA_CPP_PROVIDER_ID } from "./defaults.js";

export const MANAGED_LLAMA_CPP_CONFIG_REQUIRED_MESSAGE =
  "Local embeddings need the managed llama.cpp server config. Run `openclaw configure`, choose llama.cpp once, then retry `openclaw memory status --deep`.";

export function resolveManagedLlamaCppProviderConfig(config: OpenClawConfig): ModelProviderConfig {
  const provider = config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  if (!provider?.localService || !provider.baseUrl) {
    throw new Error(MANAGED_LLAMA_CPP_CONFIG_REQUIRED_MESSAGE);
  }
  return provider;
}
