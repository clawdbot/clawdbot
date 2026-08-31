// Resolves provider config ownership between core and plugins.
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
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

function providerConfigDeclaresModel(
  providerConfig: { models?: readonly { id?: string }[] } | undefined,
  model: string,
): boolean {
  const trimmedModel = model.trim();
  return Boolean(
    trimmedModel &&
    providerConfig?.models?.some((candidate) => candidate.id?.trim() === trimmedModel),
  );
}

/** Resolves provider/model refs used to scope model catalog discovery. */
export function resolveModelCatalogScope(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
}): { providerRefs: string[]; modelRefs: string[] } {
  const provider = params.provider.trim();
  const model = params.model.trim();
  const providerConfig = findNormalizedProviderValue(params.cfg?.models?.providers, provider);
  const modelRefs = providerConfigDeclaresModel(providerConfig, model)
    ? [provider && model ? `${provider}/${model}` : model]
    : [provider && model ? `${provider}/${model}` : model, model];
  // Scope ordering feeds deterministic discovery and prompt/cache inputs.
  return {
    providerRefs: normalizeUniqueSingleOrTrimmedStringList([provider, providerConfig?.api]),
    modelRefs: normalizeUniqueSingleOrTrimmedStringList(modelRefs),
  };
}
