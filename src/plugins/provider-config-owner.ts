// Resolves provider config ownership between core and plugins.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Core built-in model API ids that do not imply plugin ownership of a provider config. */
export const CORE_BUILT_IN_MODEL_APIS = new Set([
  "anthropic-messages",
  "azure-openai-responses",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "openai-chatgpt-responses",
  "openai-completions",
  "openai-responses",
]);

/** Returns the plugin API id that owns a provider config when it is not core built-in. */
export function resolveProviderConfigApiOwnerHint(params: {
  provider: string;
  config?: OpenClawConfig;
}): string | undefined {
  const providers = params.config?.models?.providers;
  if (!providers) {
    return undefined;
  }
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!normalizedProvider) {
    return undefined;
  }
  const providerConfig =
    providers[params.provider] ??
    Object.entries(providers).find(
      ([candidateId]) => normalizeProviderId(candidateId) === normalizedProvider,
    )?.[1];
  const api =
    typeof providerConfig?.api === "string" ? normalizeProviderId(providerConfig.api) : "";
  if (!api || api === normalizedProvider || CORE_BUILT_IN_MODEL_APIS.has(api)) {
    return undefined;
  }
  return api;
}
